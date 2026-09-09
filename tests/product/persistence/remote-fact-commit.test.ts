import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CommandId, HabitActionId, LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import { prepareRemoteFact } from '@/core/domain/remote-fact-validation';
import { commitRemoteFacts, type RemoteFactCommitPlan } from '@/core/persistence/remote-fact-commit';
import { appendHabitAction, listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry, getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { applyRemoteFactInboxChanges, readRemoteFactInbox } from '@/core/persistence/repositories/remote-fact-inbox';
import { appendOutbox } from '@/core/persistence/repositories/support';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const date = '2026-09-09' as LogicalDate;
const uuid = (n: number) => `abcdefab-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const action: HabitAction = {
  id: uuid(1) as HabitActionId, commandId: uuid(2) as CommandId, boardId: uuid(3) as BoardId,
  logicalDate: date, checkInId: null, kind: 'uncheck', policyJson: null,
  createdAt: 100, mutationStamp: '00000000000100-00000-test',
};
const claim: CoinLedgerRow = {
  id: uuid(4) as LedgerEntryId, kind: 'claim', delta: -5, boardId: null, checkInId: null,
  runKey: null, rewardId: uuid(5) as RewardId, rewardTitleSnapshot: 'Coffee', reversesId: null,
  scopeKey: null, sourceActionId: null, reconciliationKey: null, adjustsId: null,
  provenanceJson: null, logicalDate: date, createdAt: 101,
  mutationStamp: '00000000000101-00000-test', deletedAt: null,
};
const emptyPlan = (): RemoteFactCommitPlan => ({ insertions: [], enqueue: [], inbox: { upserts: [], removals: [] } });
const tuple = (factType: 'habit_action' | 'ledger_entry', value: { id: string; mutationStamp: string }) =>
  ({ factType, factId: value.id, mutationStamp: value.mutationStamp });

describe('final immutable admission writes', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  const snapshot = () => Promise.all(['habit_actions', 'coin_ledger', 'remote_fact_inbox',
    'mutation_outbox', 'command_receipts', 'app_settings'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  const queue = () => h.db.getAllAsync('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox ORDER BY id');
  const prepare = (value = action, enqueueOnAdmission = false) => prepareRemoteFact({ factType: 'habit_action',
    factId: value.id, value, enqueueOnAdmission }, h.deps.hashing);

  it('leaves an empty final plan unchanged with no outbox lookup', async () => {
    const before = await snapshot();
    const read = jest.spyOn(h.db, 'getAllAsync');
    const result = await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, emptyPlan(), 500));
    expect(result).toEqual({ localChanged: false,
      counts: { variants: 0, payloadBytes: 0, pending: 0, blocked: 0, quarantined: 0 } });
    expect(read.mock.calls.filter(([sql]) => sql.includes('mutation_outbox'))).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it('appends received facts exactly, preserves planned upload intent, and finalizes the inbox atomically', async () => {
    const incoming = await prepare(action, true);
    const pending = await prepare({ ...action, id: uuid(6) as HabitActionId });
    await applyRemoteFactInboxChanges(h.db, { upserts: [
      { prepared: incoming, disposition: { state: 'pending', reason: 'dependency' } },
    ], removals: [] }, 250);
    const result = await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, {
      insertions: [{ factType: 'habit_action', value: action }, { factType: 'ledger_entry', value: claim }],
      enqueue: [tuple('habit_action', action)],
      inbox: { removals: [incoming], upserts: [{ prepared: pending, disposition: { state: 'pending', reason: 'dependency' } }] },
    }, 500));
    expect(await listHabitActions(h.db, action.boardId, date)).toEqual([action]);
    expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
    expect(await queue()).toEqual([{ entity_type: 'habit_action', entity_id: action.id,
      mutation_stamp: action.mutationStamp, created_at: 500 }]);
    expect(await readRemoteFactInbox(h.db)).toEqual([expect.objectContaining({ factId: pending.factId, firstSeenAt: 500 })]);
    expect(result).toMatchObject({ localChanged: true, counts: { variants: 1, pending: 1 } });
  });

  it('coalesces exact queued tuples in one lookup while preserving typed identity, stamp, and binary case', async () => {
    const existing = tuple('habit_action', action);
    await appendOutbox(h.db, existing.factType, existing.factId, existing.mutationStamp, 200);
    await appendOutbox(h.db, existing.factType, existing.factId, existing.mutationStamp, 201);
    const wanted = [existing, tuple('ledger_entry', action), { ...existing, factId: action.id.toUpperCase() },
      { ...existing, mutationStamp: claim.mutationStamp }];
    const read = jest.spyOn(h.db, 'getAllAsync');
    const result = await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, {
      ...emptyPlan(), enqueue: [...wanted, ...wanted].reverse(),
    }, 500));
    const queries = read.mock.calls.filter(([sql]) => sql.includes('mutation_outbox'));
    expect(queries).toHaveLength(1);
    expect(JSON.parse(queries[0][1]![0] as string)).toHaveLength(4);
    expect(await queue()).toHaveLength(5);
    expect(result.localChanged).toBe(true);
    const replay = await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, { ...emptyPlan(), enqueue: wanted }, 600));
    expect(replay.localChanged).toBe(false);
    expect(await queue()).toHaveLength(5);
  });

  it('marks inbox-only promotions and restore-intent updates as changes without spinning on unchanged pending work', async () => {
    const prepared = await prepare();
    const inbox = { upserts: [{ prepared, disposition: { state: 'pending' as const, reason: 'dependency' as const } }], removals: [] };
    const commit = () => h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, { ...emptyPlan(), inbox }, 500));
    expect((await commit()).localChanged).toBe(true);
    expect((await commit()).localChanged).toBe(false);
    prepared.enqueueOnAdmission = true;
    expect((await commit()).localChanged).toBe(true);
    expect((await readRemoteFactInbox(h.db))[0]).toMatchObject({ enqueueOnAdmission: true, firstSeenAt: 500 });
    expect((await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, {
      ...emptyPlan(), inbox: { upserts: [], removals: [prepared] },
    }, 600))).localChanged).toBe(true);
    expect(await readRemoteFactInbox(h.db)).toEqual([]);
  });

  it('requeues an explicitly restored accepted tuple after a previous upload removed it', async () => {
    await appendLedgerEntry(h.db, claim);
    const plan = { ...emptyPlan(), enqueue: [tuple('ledger_entry', claim)] };
    await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, plan, 500));
    await h.db.runAsync('DELETE FROM mutation_outbox WHERE entity_id = ?', [claim.id]);
    expect((await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, plan, 600))).localChanged).toBe(true);
    expect(await queue()).toEqual([{ entity_type: 'ledger_entry', entity_id: claim.id,
      mutation_stamp: claim.mutationStamp, created_at: 600 }]);
    expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
  });

  it.each(['habit_action', 'ledger_entry'] as const)('rolls back a new prefix when planned-new %s is already accepted', async factType => {
    if (factType === 'habit_action') await appendHabitAction(h.db, action);
    else await appendLedgerEntry(h.db, claim);
    const before = await snapshot();
    const duplicate = factType === 'habit_action'
      ? { factType, value: action } : { factType, value: claim };
    await expect(h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, { ...emptyPlan(), insertions: [
      { factType: 'habit_action', value: { ...action, id: uuid(10) as HabitActionId } }, duplicate,
    ] }, 500))).rejects.toMatchObject({ reason: 'integrity' });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['habit_actions', 'coin_ledger', 'mutation_outbox', 'remote_fact_inbox', 'command_receipts'])(
    'rolls back all earlier real writes after a late %s failure and permits a fresh retry', async table => {
      const prepared = await prepare({ ...action, id: uuid(11) as HabitActionId });
      const plan: RemoteFactCommitPlan = {
        insertions: [{ factType: 'habit_action', value: action }, { factType: 'ledger_entry', value: claim }],
        enqueue: [tuple('ledger_entry', claim)],
        inbox: { upserts: [{ prepared, disposition: { state: 'pending', reason: 'dependency' } }], removals: [] },
      };
      const before = await snapshot();
      const failure = new Error(`late ${table}`);
      const run = h.db.runAsync.bind(h.db);
      const spy = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
        const result = await run(sql, params);
        if (sql.includes(`INSERT INTO ${table}`)) throw failure;
        return result;
      });
      const perform = () => h.db.withExclusiveTransactionAsync(async tx => {
        await tx.runAsync('UPDATE app_settings SET hlc_counter = 42');
        const result = await commitRemoteFacts(tx, plan, 500);
        await tx.runAsync('INSERT INTO command_receipts (command_id, outcome, created_at) VALUES (?, ?, ?)',
          [uuid(12), '{"ok":true}', 500]);
        return result;
      });
      await expect(perform()).rejects.toBe(failure);
      expect(await snapshot()).toEqual(before);
      spy.mockRestore();
      expect((await perform()).localChanged).toBe(true);
      expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
      expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toHaveLength(1);
    },
  );

  it('checks cancellation after awaited inbox writes and preserves the original thrown object', async () => {
    const prepared = await prepare();
    const before = await snapshot();
    const failure = { cancelled: true };
    let cancelled = false;
    const run = h.db.runAsync.bind(h.db);
    jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await run(sql, params);
      if (sql.includes('INSERT INTO remote_fact_inbox')) cancelled = true;
      return result;
    });
    await expect(h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, {
      ...emptyPlan(), enqueue: [tuple('habit_action', action)],
      inbox: { upserts: [{ prepared, disposition: { state: 'pending', reason: 'dependency' } }], removals: [] },
    }, 500, () => { if (cancelled) throw failure; }))).rejects.toBe(failure);
    expect(await snapshot()).toEqual(before);
  });

  it('captures all final rows, tuples and inbox metadata before the first database await', async () => {
    const prepared = await prepare();
    const pending = { ...prepared };
    const laterClaim = { ...claim };
    const enqueue = [tuple('ledger_entry', laterClaim)];
    const disposition = { state: 'pending' as const, reason: 'dependency' as const };
    const plan: RemoteFactCommitPlan = {
      insertions: [{ factType: 'habit_action', value: action }, { factType: 'ledger_entry', value: laterClaim }],
      enqueue, inbox: { upserts: [{ prepared: pending, disposition }], removals: [] },
    };
    const read = h.db.getFirstAsync.bind(h.db);
    let changed = false;
    jest.spyOn(h.db, 'getFirstAsync').mockImplementation(async (sql, params) => {
      if (!changed) {
        changed = true;
        laterClaim.delta = -99;
        enqueue[0].mutationStamp = '00000000009999-00000-mutated';
        enqueue.push(tuple('habit_action', action));
        pending.payload = 'broken';
        pending.enqueueOnAdmission = true;
        Object.assign(disposition, { state: 'quarantined', reason: 'invalid' });
        (plan.insertions as unknown[]).pop();
      }
      return read(sql, params);
    });
    await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, plan, 500));
    expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
    expect(await queue()).toEqual([{ entity_type: 'ledger_entry', entity_id: claim.id,
      mutation_stamp: claim.mutationStamp, created_at: 500 }]);
    expect(await readRemoteFactInbox(h.db)).toEqual([expect.objectContaining({ payload: prepared.payload,
      state: 'pending', reason: 'dependency', enqueueOnAdmission: false })]);
  });

  it('uses one non-correlated outbox scan for many requested tuples without a parameter-count or global-fact cap', async () => {
    const enqueue = Array.from({ length: 1201 }, (_, n) => tuple('ledger_entry', { ...claim, id: uuid(n + 100) }));
    await appendOutbox(h.db, 'board', uuid(99), action.mutationStamp, 123);
    const read = jest.spyOn(h.db, 'getAllAsync');
    await h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx, { ...emptyPlan(), enqueue }, 500));
    const queries = read.mock.calls.filter(([sql]) => sql.includes('mutation_outbox'));
    expect(queries).toHaveLength(1);
    const [sql, params] = queries[0];
    const queryPlan = await h.db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
    expect(queryPlan.filter(row => row.detail === 'SCAN mutation_outbox')).toHaveLength(1);
    expect(queryPlan.some(row => row.detail.includes('CORRELATED'))).toBe(false);
    expect(JSON.parse(params![0] as string)).toHaveLength(1201);
    expect(await queue()).toHaveLength(1202);
  });

  it.each([-0, -1, Number.MAX_SAFE_INTEGER + 1, Infinity])('rejects invalid acquired queue time %s before any writes', async now => {
    const before = await snapshot();
    await expect(h.db.withExclusiveTransactionAsync(tx => commitRemoteFacts(tx,
      { ...emptyPlan(), enqueue: [tuple('ledger_entry', claim)] }, now))).rejects.toMatchObject({ reason: 'envelope' });
    expect(await snapshot()).toEqual(before);
  });
});
