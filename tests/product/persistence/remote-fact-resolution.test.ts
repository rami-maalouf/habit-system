import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import { prepareRemoteFact, type RemoteFactCandidate } from '@/core/domain/remote-fact-validation';
import { admitRemoteFacts } from '@/core/persistence/remote-fact-admission';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry, getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { applyRemoteFactInboxChanges } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const candidate = (value: HabitAction | CoinLedgerRow, enqueueOnAdmission = false): RemoteFactCandidate => ({
  factType: 'delta' in value ? 'ledger_entry' : 'habit_action', factId: value.id, value, enqueueOnAdmission,
});
const checkScope = checkFixture.scope as Pick<HabitAction, 'boardId' | 'logicalDate'>;
const canonicalRows = (rows: CoinLedgerRow[]) => [...new Set(rows.map(canonicalCoinLedger))].sort();

describe('complete remote fact resolution through the caller transaction', () => {
  let h: TestHarness;
  const directories: string[] = [];
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  const admit = (values: (HabitAction | CoinLedgerRow)[] = []) => h.db.withExclusiveTransactionAsync(tx =>
    admitRemoteFacts(tx, { candidates: values.map(value => candidate(value)), acquiredNow: 900 }, h.deps.hashing));
  const rows = async (scopeKey: string) => {
    const ids = await h.db.getAllAsync<{ id: CoinLedgerRow['id'] }>('SELECT id FROM coin_ledger WHERE scope_key = ? ORDER BY id', [scopeKey]);
    return Promise.all(ids.map(async ({ id }) => (await getLedgerEntry(h.db, id))!));
  };

  it.each(checkFixture.cases)('admits the exact check replay bytes without a speculative prefix: $name', async vector => {
    const actions = vector.actions as HabitAction[];
    const result = await admit([...actions].reverse());
    expect(result.admitted).toHaveLength(actions.length);
    expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 0 });
    expect(canonicalRows(await rows(`check:${checkFixture.scope.boardId}:${checkFixture.scope.logicalDate}`)))
      .toEqual(canonicalRows(vector.ordinaryRows as CoinLedgerRow[]));
    expect((await admit()).localChanged).toBe(false);
  });

  it.each(bonusFixture.reconciliationCases)('admits all received roles and preserves the exact bonus union: $name', async vector => {
    const received = vector.rows as CoinLedgerRow[];
    const result = await admit([...received, ...vector.actions as HabitAction[]].reverse());
    expect(result.admitted.filter(item => item.factType === 'ledger_entry').map(item => item.factId).sort())
      .toEqual(received.map(row => row.id).sort());
    expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 0 });
    expect(canonicalRows(await rows(`bonus:${vector.scope.rootId}:${vector.scope.logicalDate}`)))
      .toEqual(canonicalRows([...received, ...vector.expectedAppendedRows as CoinLedgerRow[]]));
    expect((await admit([...vector.actions as HabitAction[], ...received])).localChanged).toBe(false);
  });

  it('uses only current genuine generation to admit a supplied reversal and rejects its altered same-ID sibling', async () => {
    const vector = checkFixture.cases[2];
    const award = vector.ordinaryRows[0] as CoinLedgerRow;
    const reversal = vector.ordinaryRows[1] as CoinLedgerRow;
    const result = await admit([{ ...reversal, createdAt: reversal.createdAt + 1 }, reversal, ...vector.actions as HabitAction[]]);
    expect(result.admitted).toContainEqual({ factType: 'ledger_entry', factId: reversal.id, mutationStamp: reversal.mutationStamp });
    expect(result.generated).toEqual([{ factType: 'ledger_entry', factId: award.id, mutationStamp: award.mutationStamp }]);
    expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 1 });
    expect(canonicalRows(await rows(award.scopeKey!))).toEqual(canonicalRows([award, reversal]));
    expect(await h.db.getAllAsync('SELECT state, reason FROM remote_fact_inbox')).toEqual([{ state: 'quarantined', reason: 'invalid' }]);
  });

  it('keeps a rootless source independent while its restored bonus waits for C across a file restart', async () => {
    const vector = bonusFixture.reconciliationCases[4];
    const [control, ...sources] = vector.actions as HabitAction[];
    const award = vector.rows[0] as CoinLedgerRow;
    const first = await h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx, {
      candidates: [candidate(award, true), ...sources.map(a => candidate(a))], acquiredNow: 700,
    }, h.deps.hashing));
    expect(first.admitted.map(a => a.factId).sort()).toEqual(sources.map(a => a.id).sort());
    expect(first.counts).toMatchObject({ pending: 1, quarantined: 0, blocked: 0 });
    expect(await getLedgerEntry(h.db, award.id)).toBeNull();
    expect((await admit()).localChanged).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), 'habit-resolution-')); directories.push(directory);
    const path = join(directory, 'db.sqlite');
    await h.db.runAsync('VACUUM INTO ?', [path]); await h.db.closeAsync();
    h.db = new NodeSqlDatabase(path); h.deps.db = h.db;
    const promoted = await admit([control]);
    expect(promoted.admitted).toContainEqual({ factType: 'ledger_entry', factId: award.id, mutationStamp: award.mutationStamp });
    expect(promoted.generated.some(a => a.factId === award.id)).toBe(false);
    expect(promoted.counts).toMatchObject({ pending: 0, quarantined: 0, blocked: 0 });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await h.db.getAllAsync('SELECT entity_type, created_at FROM mutation_outbox WHERE entity_id = ?', [award.id]))
      .toEqual([{ entity_type: 'ledger_entry', created_at: 900 }]);
    expect((await admit()).localChanged).toBe(false);
  });

  it('completes a required generated ID group and withholds its source when retained conflict prevents settlement', async () => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    const disputed = await prepareRemoteFact(candidate({ ...award, createdAt: award.createdAt + 1 }), h.deps.hashing);
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared: disputed, disposition: { state: 'quarantined', reason: 'conflict' } },
    ] }, 1);
    const result = await admit([source]);
    expect(result.admitted).toEqual([]); expect(result.generated).toEqual([]);
    expect(result.counts).toMatchObject({ pending: 1, quarantined: 1, blocked: 0 });
    expect(await h.db.getAllAsync('SELECT id FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT id FROM coin_ledger')).toEqual([]);
    expect((await admit()).localChanged).toBe(false);
  });

  it.each([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27])(
    'classifies the directed bonus dependency or intrinsic defect through admission: %s', async index => {
      const vector = bonusFixture.errorCases[index];
      const supplied = vector.rows as CoinLedgerRow[];
      const target = supplied[supplied.length - 1];
      const result = await admit([...vector.actions as HabitAction[], ...supplied]);
      const targetVariant = await prepareRemoteFact(candidate(target), h.deps.hashing);
      expect(await h.db.getFirstAsync('SELECT state, reason FROM remote_fact_inbox WHERE fact_id = ? AND payload_digest = ?',
        [target.id, targetVariant.payloadDigest])).toEqual(vector.expectedReason === 'missing'
        ? { state: 'pending', reason: 'dependency' } : { state: 'quarantined', reason: 'invalid' });
      expect(result.admitted.some(item => item.factId === target.id)).toBe(false);
      expect((await admit()).localChanged).toBe(false);
    });

  it('does not turn discovery for an unresolved bonus variant into an unrelated missing award', async () => {
    const vector = bonusFixture.errorCases[3];
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (const action of vector.actions as HabitAction[]) await appendHabitAction(tx, action);
    });
    const result = await admit(vector.rows as CoinLedgerRow[]);
    expect(result.admitted).toEqual([]); expect(result.generated).toEqual([]);
    expect(result.affected).toEqual({ checkScopes: [], rootScopes: [] });
    expect(result.counts).toMatchObject({ pending: 1, quarantined: 0, blocked: 0 });
    expect(await h.db.getAllAsync('SELECT id FROM coin_ledger')).toEqual([]);
    expect((await admit()).localChanged).toBe(false);
  });

  it('does not rehash an unchanged exact action context when completing a generated identity', async () => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const digest = jest.spyOn(h.deps.hashing, 'sha256');
    const result = await admit([source]);
    expect(result.generated.map(item => item.factId)).toEqual([checkFixture.cases[0].ordinaryRows[0].id]);
    const sourceBytes = canonicalHabitAction(source);
    // one admission digest and the three existing pure evidence preparation boundaries.
    expect(digest.mock.calls.filter(([bytes]) => new TextDecoder().decode(bytes) === sourceBytes)).toHaveLength(4);
  });

  it('classifies a supplied cancellation only from its complete parent and current evidence phase', async () => {
    const vector = bonusFixture.reconciliationCases[7];
    const cancellation = vector.expectedAppendedRows.find(row => row.adjustsId !== null)! as CoinLedgerRow;
    const pending = await admit([cancellation]);
    expect(pending.counts).toMatchObject({ pending: 1, quarantined: 0 });
    expect((await admit()).localChanged).toBe(false);
    const result = await admit([...vector.actions as HabitAction[], ...vector.rows as CoinLedgerRow[],
      { ...cancellation, createdAt: cancellation.createdAt + 1 }]);
    expect(result.admitted).toContainEqual({ factType: 'ledger_entry', factId: cancellation.id, mutationStamp: cancellation.mutationStamp });
    expect(result.counts).toMatchObject({ pending: 0, quarantined: 1, blocked: 0 });
    expect(canonicalRows(await rows(cancellation.scopeKey!)))
      .toEqual(canonicalRows([...vector.rows as CoinLedgerRow[], ...vector.expectedAppendedRows as CoinLedgerRow[]]));
    expect((await admit()).localChanged).toBe(false);
  });

  it('reuses one proof phase for an accepted parent and received cancellation across generated identity completion', async () => {
    const vector = bonusFixture.reconciliationCases[7];
    const cancellation = vector.expectedAppendedRows.find(row => row.adjustsId !== null)! as CoinLedgerRow;
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (const row of vector.rows as CoinLedgerRow[]) await appendLedgerEntry(tx, row);
    });
    const result = await admit([...vector.actions as HabitAction[], cancellation]);
    expect(result.admitted.filter(item => item.factType === 'ledger_entry').map(item => item.factId)).toEqual([cancellation.id]);
    expect(canonicalRows(await rows(cancellation.scopeKey!)))
      .toEqual(canonicalRows([...vector.rows as CoinLedgerRow[], ...vector.expectedAppendedRows as CoinLedgerRow[]]));
    expect((await admit()).localChanged).toBe(false);
  });

  it('rejects a self-parent cancellation before waiting for absent ordinary evidence', async () => {
    const cancellation = bonusFixture.reconciliationCases[7].expectedAppendedRows.find(row => row.adjustsId !== null)! as CoinLedgerRow;
    const result = await admit([{ ...cancellation, adjustsId: cancellation.id }]);
    expect(result.counts).toMatchObject({ pending: 0, quarantined: 1 });
    expect(result.admitted).toEqual([]); expect(result.generated).toEqual([]);
  });

  it('keeps a supplied reversal pending when both genuine removal and its original award are missing', async () => {
    const reversal = checkFixture.cases[2].ordinaryRows[1] as CoinLedgerRow;
    const result = await admit([reversal]);
    expect(result.counts).toMatchObject({ pending: 1, quarantined: 0 });
    expect(result.admitted).toEqual([]); expect(result.generated).toEqual([]);
    expect((await admit()).localChanged).toBe(false);
  });

  it('rolls back instead of replacing accepted bytes that disagree with required current generation', async () => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    const corrupt = { ...award, createdAt: award.createdAt + 1 };
    await appendLedgerEntry(h.db, corrupt);
    await expect(admit([source])).rejects.toMatchObject({ reason: 'integrity' });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(corrupt);
    expect(await h.db.getAllAsync('SELECT id FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT fact_id FROM remote_fact_inbox')).toEqual([]);
  });

  it('treats an accepted correction with missing proof dependencies as operation integrity', async () => {
    const parent = checkFixture.correction.expectedAppend[0] as CoinLedgerRow;
    await appendLedgerEntry(h.db, parent);
    await expect(h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx, {
      candidates: [], checkScopes: [checkScope], acquiredNow: 10,
    }, h.deps.hashing))).rejects.toMatchObject({ reason: 'integrity' });
    expect(await getLedgerEntry(h.db, parent.id)).toEqual(parent);
  });

  async function seedBefore(source: HabitAction, count: number) {
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (let n = 0; n < count; n++) await appendHabitAction(tx, { ...source,
        id: `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as HabitAction['id'],
        kind: 'uncheck', checkInId: null, policyJson: null, mutationStamp: '00000000000000-00000-base',
      });
    });
  }

  it.each([false, true])('uses the complete4093-base action set and distinguishes a real partial award: %s', async partial => {
    const actions = checkFixture.correction.actions as HabitAction[];
    const awards = checkFixture.correction.existingRows as CoinLedgerRow[];
    const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    await seedBefore(actions[0], 4093);
    const result = await admit([claim, ...[...actions].reverse(), ...(partial ? [awards[1]] : [])]);
    expect(result.counts).toMatchObject({ pending: 0, quarantined: 0, blocked: partial ? 3 : 0 });
    expect(result.admitted.map(x => x.factId).sort()).toEqual((partial ? [claim.id] : [claim.id, ...actions.map(a => a.id)]).sort());
    expect(canonicalRows(await rows(awards[0].scopeKey!))).toEqual(partial ? [] : [canonicalCoinLedger(awards[0])]);
    expect((await admit()).localChanged).toBe(false);
  });

  it('withholds a member own-check award when its known bonus root is overfull, while an unrelated claim commits', async () => {
    const [root, member] = bonusFixture.replayCases[1].actions as HabitAction[];
    const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    await admit([root]); await seedBefore(root, 4094);
    const beforeLedger = await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    const result = await admit([member, claim]);
    expect(result.admitted.map(a => a.factId)).toEqual([claim.id]);
    expect(result.generated).toEqual([]);
    expect(result.counts).toMatchObject({ pending: 0, quarantined: 0, blocked: 1 });
    expect(await h.db.getFirstAsync('SELECT id FROM habit_actions WHERE id = ?', [member.id])).toBeNull();
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger WHERE kind <> ? ORDER BY id', ['claim'])).toEqual(beforeLedger);
    expect((await admit()).localChanged).toBe(false);
  });
  it.each([false, true])('does not turn a pending same-ID sibling into conflict before a real commit, blocked %s', async blocked => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    const pending: CoinLedgerRow = { ...checkFixture.cases[2].ordinaryRows[1] as CoinLedgerRow, id: award.id,
      reversesId: '11111111-1111-5111-8111-111111111111' as CoinLedgerRow['id'],
      sourceActionId: '22222222-2222-4222-8222-222222222222' as HabitAction['id'] };
    if (blocked) await seedBefore(source, 4095);
    const result = await admit([pending, source, award]);
    expect(result.admitted.map(item => item.factId).sort()).toEqual(blocked ? [] : [source.id, award.id].sort());
    expect(result.counts).toMatchObject(blocked ? { pending: 1, blocked: 2, quarantined: 0 } : { pending: 0, blocked: 0, quarantined: 1 });
    const prepared = await prepareRemoteFact(candidate(pending), h.deps.hashing);
    expect(await h.db.getFirstAsync('SELECT state, reason FROM remote_fact_inbox WHERE fact_id = ? AND payload_digest = ?',
      [pending.id, prepared.payloadDigest])).toEqual(blocked ? { state: 'pending', reason: 'dependency' } : { state: 'quarantined', reason: 'conflict' });
    expect((await admit()).localChanged).toBe(false);
  });

  it('excludes the sole proposed root observation when its full component exceeds capacity', async () => {
    const control = bonusFixture.reconciliationCases[4].actions[0] as HabitAction;
    await seedBefore(control, 4096);
    const result = await admit([control]);
    expect(result.counts).toMatchObject({ pending: 0, quarantined: 0, blocked: 1 });
    expect(result.admitted).toEqual([]); expect(result.generated).toEqual([]);
    expect((await admit()).localChanged).toBe(false);
  });

  it('fails an explicit accepted-only overfull scope without hiding stored facts', async () => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    await seedBefore(source, 4097);
    await expect(h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx, {
      candidates: [], checkScopes: [checkScope], acquiredNow: 10,
    }, h.deps.hashing))).rejects.toMatchObject({ reason: 'capacity' });
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM habit_actions')).toEqual({ count: 4097 });
    expect(await h.db.getAllAsync('SELECT fact_id FROM remote_fact_inbox')).toEqual([]);
  });

  it('fails an explicit accepted-only settlement whose required generated ID is disputed', async () => {
    const source = checkFixture.cases[0].actions[0] as HabitAction;
    const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    await appendHabitAction(h.db, source);
    const disputed = await prepareRemoteFact(candidate({ ...award, createdAt: award.createdAt + 1 }), h.deps.hashing);
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared: disputed, disposition: { state: 'quarantined', reason: 'conflict' } },
    ] }, 1);
    await expect(h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx, {
      candidates: [], checkScopes: [checkScope], acquiredNow: 10,
    }, h.deps.hashing))).rejects.toMatchObject({ reason: 'integrity' });
    expect(await h.db.getAllAsync('SELECT id FROM coin_ledger')).toEqual([]);
  });

});
