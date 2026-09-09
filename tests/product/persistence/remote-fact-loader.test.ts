import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy, parseCoinPolicy } from '@/core/domain/coin-policy';
import { baselineAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CommandId, HabitActionId, LogicalDate } from '@/core/domain/ids';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { prepareRemoteFact, type PreparedRemoteFact, type RemoteFactIdentity } from '@/core/domain/remote-fact-validation';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import { createRemoteFactLoader, type RemoteFactLoaderNeeds } from '@/core/persistence/remote-fact-loader';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';
import { applyRemoteFactInboxChanges, readRemoteFactInbox } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHarness, createTestHashing, NodeSqlDatabase, TestIds, type TestHarness } from '../helpers/test-db';

const boardId = 'aaaaaaaa-0000-4000-8000-000000000001' as BoardId;
const date = '2026-09-09' as LogicalDate;
const emptyCompleted = { checkScopes: [], rootScopes: [], reverseScopes: [] };
const uuid = (n: number) => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const action = (n: number, changes: Partial<HabitAction> = {}): HabitAction => ({
  id: uuid(n) as HabitActionId, commandId: uuid(n + 10000) as CommandId,
  boardId, logicalDate: date, checkInId: null, kind: 'uncheck', policyJson: null,
  createdAt: n, mutationStamp: `00000000000000-00000-test${n}`, ...changes,
});
const identity = (row: { id: string }): RemoteFactIdentity => ({ factType: 'habit_action', factId: row.id });

describe('transaction-owned remote fact loading', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  const prepare = (value: HabitAction, enqueueOnAdmission = false): Promise<PreparedRemoteFact> =>
    prepareRemoteFact({ ...identity(value), value, enqueueOnAdmission }, h.deps.hashing);
  const snapshot = () => Promise.all(['habit_actions', 'coin_ledger', 'remote_fact_inbox',
    'mutation_outbox', 'command_receipts', 'app_settings'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));

  it('discovers empty retry work once and returns empty owned deltas without writes', async () => {
    const before = await snapshot();
    await h.db.withExclusiveTransactionAsync(async tx => {
      const read = jest.spyOn(h.db, 'getAllAsync');
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      expect(loader.initial).toEqual({ groups: [], completed: emptyCompleted });
      expect(read).toHaveBeenCalledTimes(1);
      read.mockClear();
      expect(await loader.extend({})).toEqual({ groups: [], completed: emptyCompleted });
      expect(read).not.toHaveBeenCalled();
    });
    expect(await snapshot()).toEqual(before);
  });

  it('completes accepted and all targeted variants, retains intent, and never re-emits overlapping groups', async () => {
    const a = action(1);
    await appendHabitAction(h.db, a);
    const prepared = await prepare(a);
    const conflict = await prepare({ ...a, createdAt: 2 }, true);
    const unrelated = await prepare(action(2));
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared, disposition: { state: 'pending', reason: 'dependency' } },
      { prepared: conflict, disposition: { state: 'quarantined', reason: 'conflict' } },
      { prepared: unrelated, disposition: { state: 'quarantined', reason: 'invalid' } },
    ] }, 123);
    const stored = await readRemoteFactInbox(h.db, [identity(a)]);
    const before = await snapshot();
    await h.db.withExclusiveTransactionAsync(async tx => {
      const sha256 = jest.fn(h.deps.hashing.sha256);
      const loader = await createRemoteFactLoader({ tx, sourceHashing: { ...h.deps.hashing, sha256 } },
        [{ ...prepared, enqueueOnAdmission: true }]);
      expect(loader.initial.groups).toHaveLength(1);
      const group = loader.initial.groups[0];
      expect(group.identity).toEqual(identity(a));
      expect(group.accepted).toEqual(prepared);
      expect(group.variants).toEqual([prepared, conflict].sort((l, r) => l.payloadDigest.localeCompare(r.payloadDigest)).map(p => ({
        prepared: { ...p, enqueueOnAdmission: true },
        previous: stored.find(row => row.payloadDigest === p.payloadDigest),
        route: p === prepared ? 'accepted_duplicate' : 'retained_quarantine',
      })));
      expect(sha256).toHaveBeenCalledTimes(3);
      sha256.mockClear();
      const pair = { boardId, logicalDate: date };
      expect(await loader.extend({ identities: [identity(a)], checkScopes: [pair, pair] }))
        .toEqual({ groups: [], completed: { ...emptyCompleted, checkScopes: [pair] } });
      expect(sha256).not.toHaveBeenCalled();
      const read = jest.spyOn(h.db, 'getAllAsync');
      expect(await loader.extend({ checkScopes: [pair], identities: [identity(a)] }))
        .toEqual({ groups: [], completed: emptyCompleted });
      expect(read).not.toHaveBeenCalled();
    });
    expect(await snapshot()).toEqual(before);
  });

  it('batches complete negative identity groups and preserves exact typed binary IDs', async () => {
    const ids: RemoteFactIdentity[] = Array.from({ length: 130 }, (_, n) => identity(action(n + 1)));
    ids.push({ factType: 'ledger_entry', factId: ids[0].factId }, { ...ids[0], factId: ids[0].factId.toUpperCase() });
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      const read = jest.spyOn(h.db, 'getAllAsync');
      const result = await loader.extend({ identities: [...ids, ...ids].reverse() });
      expect(result.groups).toHaveLength(ids.length);
      expect(result.groups).toEqual(expect.arrayContaining(ids.map(id => ({ identity: id, accepted: null, variants: [] }))));
      expect(result.completed).toEqual(emptyCompleted);
      for (const [, params] of read.mock.calls) expect(JSON.parse(params![0] as string).length).toBeLessThanOrEqual(64);
      read.mockClear();
      expect(await loader.extend({ identities: ids })).toEqual({ groups: [], completed: emptyCompleted });
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('finishes all fixed-selector pages beyond4096 and reports only newly completed groups and selectors', async () => {
    const rows = Array.from({ length: 4097 }, (_, n) => action(n + 1));
    const independent = action(5000, { logicalDate: '2026-09-08' as LogicalDate });
    await h.db.withExclusiveTransactionAsync(async tx => {
      for (const row of [...rows, independent]) await appendHabitAction(tx, row);
    });
    const before = await snapshot();
    await h.db.withExclusiveTransactionAsync(async tx => {
      const sha256 = jest.fn(h.deps.hashing.sha256);
      const loader = await createRemoteFactLoader({ tx, sourceHashing: { ...h.deps.hashing, sha256 } }, []);
      const read = jest.spyOn(h.db, 'getAllAsync');
      const pair = { boardId, logicalDate: date };
      const result = await loader.extend({ checkScopes: [pair] });
      expect(result.groups.map(group => group.accepted!.fact!.value)).toEqual(rows);
      expect(result.completed).toEqual({ ...emptyCompleted, checkScopes: [pair] });
      expect(sha256).toHaveBeenCalledTimes(4097);
      const pageReads = read.mock.calls.filter(([sql]) => sql.includes('WITH selected'));
      expect(pageReads).toHaveLength(65);
      expect(pageReads.every(([, params]) => params!.includes(JSON.stringify([{ id: boardId, logicalDate: date }])))).toBe(true);
      expect(read.mock.calls.every(([sql]) => !/check_ins|FROM boards|notes|amount/i.test(sql))).toBe(true);
      sha256.mockClear();
      const overlap = await loader.extend({ rootScopes: [{ rootId: boardId, logicalDate: date }] });
      expect(overlap).toEqual({ groups: [], completed: { ...emptyCompleted, rootScopes: [{ rootId: boardId, logicalDate: date }] } });
      expect(sha256).not.toHaveBeenCalled();
      const next = await loader.extend({ checkScopes: [{ boardId, logicalDate: independent.logicalDate }] });
      expect(next.groups.map(group => group.accepted!.fact!.value)).toEqual([independent]);
      expect(result.groups).toHaveLength(4097);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('returns historical reverse/proof-only roots but expands no source, control or diagnostic dependencies by itself', async () => {
    const vector = bonusFixture.reconciliationCases[2];
    const source = vector.actions[1] as HabitAction;
    const former = { ...source, policyJson: canonicalCoinPolicy({ ...parseCoinPolicy(source.policyJson!),
      rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
    const rows = [vector.rows[0], vector.rows[2]] as CoinLedgerRow[];
    await appendHabitAction(h.db, former);
    for (const row of rows) await appendLedgerEntry(h.db, row);
    const diagnostic = await prepareRemoteFact({ ...identity(action(800)), value: { ...action(800), createdAt: -0,
      sourceActionId: uuid(999) }, enqueueOnAdmission: true }, h.deps.hashing);
    expect(diagnostic.fact).toBeNull();
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared: diagnostic, disposition: { state: 'quarantined', reason: 'invalid' } },
    ] }, 42);
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, [diagnostic]);
      expect(loader.initial.groups).toHaveLength(1);
      expect(loader.initial.groups[0].variants[0]).toMatchObject({ prepared: { fact: null }, route: 'invalid_diagnostic' });
      const reversed = await loader.extend({ reverseScopes: [{ boardId: former.boardId, logicalDate: former.logicalDate }] });
      expect(reversed.groups.map(group => group.accepted!.fact!.value)).toEqual(expect.arrayContaining(rows));
      expect(reversed.groups).toHaveLength(2);
      const rooted = await loader.extend({ rootScopes: [vector.scope as { rootId: BoardId; logicalDate: LogicalDate }] });
      expect(rooted.groups).toEqual([]);
      const explicit = await loader.extend({ identities: [identity(former), identity(vector.actions[0])] });
      expect(explicit.groups).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity: identity(former), accepted: expect.objectContaining({ fact: { factType: 'habit_action', value: former } }) }),
        { identity: identity(vector.actions[0]), accepted: null, variants: [] },
      ]));
      const read = jest.spyOn(h.db, 'getAllAsync');
      expect(await loader.extend({ reverseScopes: [{ boardId: former.boardId, logicalDate: '2026-09-09' as LogicalDate }] }))
        .toEqual({ groups: [], completed: { ...emptyCompleted, reverseScopes: [{ boardId: former.boardId, logicalDate: '2026-09-09' }] } });
      expect(JSON.stringify(read.mock.calls)).not.toContain(uuid(999));
    });
  });

  it('captures supplied values and hashing methods before the first awaited read', async () => {
    const a = action(1); const prepared = await prepare(a, true);
    const expected = structuredClone(prepared);
    const b = action(2); await appendHabitAction(h.db, b);
    const baseline = await baselineAction({ id: uuid(50) as NonNullable<HabitAction['checkInId']>, boardId, logicalDate: date }, h.deps.hashing);
    await appendHabitAction(h.db, baseline);
    const receiver = {};
    const methodsCalled: string[] = [];
    const sourceHashing = { receiver,
      async sha1(bytes: Uint8Array) { expect(this.receiver).toBe(receiver); methodsCalled.push('sha1'); return h.deps.hashing.sha1(bytes); },
      async sha256(bytes: Uint8Array) { expect(this.receiver).toBe(receiver); methodsCalled.push('sha256'); return h.deps.hashing.sha256(bytes); },
    };
    const supplied = [prepared];
    const read = h.db.getAllAsync.bind(h.db);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => { await held; return read(sql, params); });
    const pending = createRemoteFactLoader({ tx: h.db, sourceHashing }, supplied);
    supplied.length = 0; prepared.enqueueOnAdmission = false;
    prepared.fact!.value.createdAt = 999; prepared.payload = 'changed';
    sourceHashing.sha1 = async () => { throw new Error('replaced method must not run'); };
    sourceHashing.sha256 = async () => { throw new Error('replaced method must not run'); };
    release();
    const loader = await pending;
    expect(loader.initial.groups[0].variants[0].prepared).toEqual(expected);
    const result = await loader.extend({ identities: [identity(b)] });
    expect(result.groups[0].accepted).toEqual(await prepare(b));
    expect((await loader.extend({ identities: [identity(baseline)] })).groups[0].accepted!.fact!.value).toEqual(baseline);
    expect(methodsCalled).toContain('sha1'); expect(methodsCalled).toContain('sha256');
  });

  it('captures queued extension arguments, serializes overlaps and keeps returned data detached from cache', async () => {
    const a = action(1); await appendHabitAction(h.db, a);
    const loader = await createRemoteFactLoader({ tx: h.db, sourceHashing: h.deps.hashing }, []);
    const read = h.db.getAllAsync.bind(h.db);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => { await held; return read(sql, params); });
    const needs = { identities: [{ ...identity(a), ignored: 'private note' }], checkScopes: [{ boardId, logicalDate: date }] };
    const first = loader.extend(needs);
    const second = loader.extend(needs);
    needs.identities[0].factId = uuid(999); needs.checkScopes[0].logicalDate = '9999-12-31' as LogicalDate;
    needs.identities.length = 0;
    release();
    const result = await first;
    expect(result.groups[0].accepted!.fact!.value).toEqual(a);
    expect(await second).toEqual({ groups: [], completed: emptyCompleted });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('private note');
    result.groups[0].accepted!.fact!.value.createdAt = 200;
    result.groups[0].accepted!.payload = 'mutated result';
    result.completed.checkScopes[0].logicalDate = '0000-01-01' as LogicalDate;
    expect(await loader.extend({ rootScopes: [{ rootId: boardId, logicalDate: date }] }))
      .toEqual({ groups: [], completed: { ...emptyCompleted, rootScopes: [{ rootId: boardId, logicalDate: date }] } });
    spy.mockClear();
    expect(await loader.extend({ checkScopes: [{ boardId, logicalDate: date }] })).toEqual({ groups: [], completed: emptyCompleted });
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps one WAL snapshot across retry discovery, missing groups and later selector waves, then reloads fresh bytes after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'habit-remote-loader-'));
    const path = join(directory, 'db.sqlite');
    let db = new NodeSqlDatabase(path); const other = new NodeSqlDatabase(path);
    try {
      await db.execAsync('PRAGMA journal_mode = WAL');
      const hashing = createTestHashing();
      expect((await initializeProductDatabase(db, new TestIds(), hashing)).ok).toBe(true);
      const a = action(1); const b = action(2);
      const original = await prepare(a); const conflict = await prepare({ ...a, createdAt: 3 }, true);
      await applyRemoteFactInboxChanges(db, { removals: [], upserts: [
        { prepared: original, disposition: { state: 'blocked_capacity', reason: 'scope_capacity' } },
      ] }, 42);
      const read = db.getAllAsync.bind(db); let intervened = false;
      const spy = jest.spyOn(db, 'getAllAsync').mockImplementation(async (sql, params) => {
        const result = await read(sql, params);
        if (!intervened) {
          intervened = true;
          await other.withExclusiveTransactionAsync(async tx => {
            await appendHabitAction(tx, b);
            await applyRemoteFactInboxChanges(tx, { removals: [], upserts: [
              { prepared: conflict, disposition: { state: 'quarantined', reason: 'conflict' } },
            ] }, 43);
          });
        }
        return result;
      });
      await db.withTransactionAsync(async tx => {
        const loader = await createRemoteFactLoader({ tx, sourceHashing: hashing }, []);
        expect(loader.initial.groups[0].variants).toHaveLength(1);
        expect(loader.initial.groups[0].variants[0].previous).toMatchObject({ state: 'blocked_capacity', firstSeenAt: 42 });
        expect(await loader.extend({ identities: [identity(b)] })).toEqual({
          groups: [{ identity: identity(b), accepted: null, variants: [] }], completed: emptyCompleted,
        });
        expect((await loader.extend({ checkScopes: [{ boardId, logicalDate: date }] })).groups).toEqual([]);
      });
      spy.mockRestore();
      const before = await db.getAllAsync('SELECT * FROM remote_fact_inbox ORDER BY payload_digest');
      await db.closeAsync(); db = new NodeSqlDatabase(path);
      await db.withTransactionAsync(async tx => {
        const loader = await createRemoteFactLoader({ tx, sourceHashing: hashing }, []);
        expect(loader.initial.groups[0].variants).toHaveLength(2);
        expect(loader.initial.groups[0].variants.map(v => v.previous!.firstSeenAt).sort()).toEqual([42, 43]);
        const loaded = await loader.extend({ checkScopes: [{ boardId, logicalDate: date }] });
        expect(loaded.groups.map(group => group.accepted!.fact!.value)).toEqual([b]);
      });
      expect(await db.getAllAsync('SELECT * FROM remote_fact_inbox ORDER BY payload_digest')).toEqual(before);
    } finally { await other.closeAsync(); await db.closeAsync(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['accepted', 'stored'] as const)('keeps %s hashing failures as one guarded provider error and preserves every table', async origin => {
    const a = action(1); const failure = new RemoteFactHashingError(new Error('provider-owned nested cause'));
    if (origin === 'accepted') await appendHabitAction(h.db, a);
    else await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared: await prepare(a), disposition: { state: 'pending', reason: 'dependency' } },
    ] }, 42);
    const before = await snapshot();
    const sourceHashing = { ...h.deps.hashing, sha256: async () => { throw failure; } };
    const promise = h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing }, []);
      return loader.extend({ identities: [identity(a)] });
    });
    const caught = await promise.catch(cause => cause);
    expect(caught).toBeInstanceOf(RemoteFactHashingError);
    expect(caught.cause).toBe(failure);
    expect(await snapshot()).toEqual(before);
  });

  it('poisons an extension after a real SQL failure without losing partial private progress on retry', async () => {
    const rows = Array.from({ length: 65 }, (_, n) => action(n + 1));
    for (const row of rows) await appendHabitAction(h.db, row);
    const before = await snapshot();
    const failure = Object.assign(new Error('cancelled SQL'), { name: 'AbortError' });
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      const read = h.db.getAllAsync.bind(h.db); let lookups = 0;
      const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) => {
        if (sql.includes('FROM remote_fact_inbox') && ++lookups === 2) throw failure;
        return read(sql, params);
      });
      await expect(loader.extend({ identities: rows.map(identity) })).rejects.toBe(failure);
      spy.mockClear();
      await expect(loader.extend({ identities: rows.map(identity) })).rejects.toBe(failure);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      expect((await loader.extend({ identities: rows.map(identity) })).groups).toHaveLength(65);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('returns accepted claims without reward joins and compares previously loaded check ledger bytes on scope overlap', async () => {
    const claim = checkFixture.shapeRows.find(row => row.kind === 'claim')! as CoinLedgerRow;
    const award = checkFixture.correction.existingRows[0] as CoinLedgerRow;
    for (const row of [claim, award]) await appendLedgerEntry(h.db, row);
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      const direct = await loader.extend({ identities: [claim, award].map(row => ({ factType: 'ledger_entry', factId: row.id })) });
      expect(direct.groups.map(group => group.accepted!.fact!.value)).toEqual(expect.arrayContaining([claim, award]));
      expect(direct.groups).toHaveLength(2);
      expect((await loader.extend({ checkScopes: [checkFixture.scope as { boardId: BoardId; logicalDate: LogicalDate }] })).groups).toEqual([]);
    });
    expect(await h.db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
  });

  it.each([
    { identities: [{ factType: 'unsupported', factId: uuid(1) }] },
    { identities: [{ factType: 'habit_action', factId: 2 }] },
    { identities: [{ factType: 'ledger_entry', factId: 'not-an-id' }] },
    { checkScopes: [{ boardId: 2, logicalDate: date }] },
    { rootScopes: [{ rootId: 'not-an-id', logicalDate: date }] },
    { reverseScopes: [{ boardId, logicalDate: 2 }] },
    { checkScopes: [{ boardId, logicalDate: '2026-02-30' }] },
  ])('rejects malformed explicit selectors before reading: %j', async needs => {
    const loader = await createRemoteFactLoader({ tx: h.db, sourceHashing: h.deps.hashing }, []);
    const read = jest.spyOn(h.db, 'getAllAsync');
    await expect(loader.extend(needs as RemoteFactLoaderNeeds)).rejects.toMatchObject({ reason: 'envelope' });
    expect(read).not.toHaveBeenCalled();
  });

  it('retains the exact cause when capturing a provider method fails before SQL', async () => {
    const failure = new Error('getter aborted');
    const sourceHashing = Object.defineProperty({ ...h.deps.hashing }, 'sha256', { get: () => { throw failure; } });
    const read = jest.spyOn(h.db, 'getAllAsync');
    await expect(createRemoteFactLoader({ tx: h.db, sourceHashing }, [])).rejects.toMatchObject({ cause: failure });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['payload', 'enqueue_on_admission', 'state'] as const)('rejects repeated stored variant %s changes inside a violated snapshot', async column => {
    const prepared = await prepare(action(1));
    const changed = await prepare(action(1, { createdAt: 2 }));
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared, disposition: { state: 'pending', reason: 'dependency' } },
    ] }, 42);
    const before = await snapshot();
    const read = h.db.getAllAsync.bind(h.db); let intervened = false;
    const spy = jest.spyOn(h.db, 'getAllAsync').mockImplementation(async (sql, params) => {
      const rows = await read(sql, params);
      if (!intervened && sql.includes('FROM remote_fact_inbox')) {
        intervened = true;
        if (column === 'payload') await h.db.runAsync('UPDATE remote_fact_inbox SET payload = ?, payload_bytes = ?', [changed.payload, changed.payloadBytes]);
        else if (column === 'state') await h.db.execAsync("UPDATE remote_fact_inbox SET state = 'blocked_capacity', reason = 'scope_capacity'");
        else await h.db.execAsync('UPDATE remote_fact_inbox SET enqueue_on_admission = 1');
      }
      return rows;
    });
    await expect(h.db.withExclusiveTransactionAsync(tx => createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, [])))
      .rejects.toMatchObject({ reason: 'integrity' });
    spy.mockRestore();
    expect(await snapshot()).toEqual(before);
  });

  it('treats persisted digest corruption as operation integrity failure, not a new diagnostic', async () => {
    const prepared = await prepare(action(1));
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: [
      { prepared, disposition: { state: 'pending', reason: 'dependency' } },
    ] }, 42);
    await h.db.runAsync('UPDATE remote_fact_inbox SET payload_digest = ?', ['0'.repeat(64)]);
    const before = await snapshot();
    await expect(createRemoteFactLoader({ tx: h.db, sourceHashing: h.deps.hashing }, [])).rejects.toMatchObject({ reason: 'integrity' });
    expect(await snapshot()).toEqual(before);
  });

  it('validates accepted baseline IDs while preserving valid historical evidence exactly', async () => {
    const baseline = await baselineAction({ id: uuid(40) as NonNullable<HabitAction['checkInId']>, boardId, logicalDate: date }, h.deps.hashing);
    await appendHabitAction(h.db, baseline);
    const loader = await createRemoteFactLoader({ tx: h.db, sourceHashing: h.deps.hashing }, []);
    expect((await loader.extend({ identities: [identity(baseline)] })).groups[0].accepted!.fact!.value).toEqual(baseline);
    const invalid = { ...baseline, id: uuid(41).replace('-4000-', '-5000-') as HabitActionId };
    await appendHabitAction(h.db, invalid);
    const before = await snapshot();
    await expect(loader.extend({ identities: [identity(invalid)] })).rejects.toMatchObject({ reason: 'integrity' });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['habit_action', 'ledger_entry'] as const)('refuses changed accepted %s bytes through a later overlapping selector', async factType => {
    const a = action(1); const award = checkFixture.correction.existingRows[0] as CoinLedgerRow;
    if (factType === 'habit_action') await appendHabitAction(h.db, a);
    else await appendLedgerEntry(h.db, award);
    const before = await snapshot();
    await expect(h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      await loader.extend({ identities: [{ factType, factId: factType === 'habit_action' ? a.id : award.id }] });
      if (factType === 'habit_action') {
        await h.db.execAsync('DROP TRIGGER habit_actions_no_update');
        await tx.runAsync('UPDATE habit_actions SET created_at = 999 WHERE id = ?', [a.id]);
      } else {
        await h.db.execAsync('DROP TRIGGER coin_ledger_no_update');
        await tx.runAsync('UPDATE coin_ledger SET created_at = 999 WHERE id = ?', [award.id]);
      }
      await loader.extend({ checkScopes: [factType === 'habit_action' ? { boardId, logicalDate: date }
        : checkFixture.scope as { boardId: BoardId; logicalDate: LogicalDate }] });
    })).rejects.toMatchObject({ reason: 'integrity' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a newly accepted identity that contradicts a prior completed negative lookup', async () => {
    const a = action(1); const before = await snapshot();
    await expect(h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      expect((await loader.extend({ identities: [identity(a)] })).groups[0].accepted).toBeNull();
      await appendHabitAction(tx, a);
      await loader.extend({ checkScopes: [{ boardId, logicalDate: date }] });
    })).rejects.toMatchObject({ reason: 'integrity' });
    expect(await snapshot()).toEqual(before);
  });

  it('loads every newly targeted quarantined alternative for a later generated identity without following its sources', async () => {
    const award = checkFixture.correction.existingRows[0] as CoinLedgerRow;
    const variants = await Promise.all([award, { ...award, createdAt: award.createdAt + 1 }].map(value => prepareRemoteFact({
      factType: 'ledger_entry', factId: value.id, value, enqueueOnAdmission: true,
    }, h.deps.hashing)));
    await applyRemoteFactInboxChanges(h.db, { removals: [], upserts: variants.map(prepared => ({ prepared,
      disposition: { state: 'quarantined', reason: 'conflict' } as const,
    })) }, 42);
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      expect(loader.initial.groups).toEqual([]);
      const read = jest.spyOn(h.db, 'getAllAsync');
      const result = await loader.extend({ identities: [{ factType: 'ledger_entry', factId: award.id }] });
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].accepted).toBeNull();
      expect(result.groups[0].variants.map(v => v.prepared)).toEqual(expect.arrayContaining(variants));
      expect(result.groups[0].variants.map(v => v.route)).toEqual(['retained_quarantine', 'retained_quarantine']);
      expect(JSON.stringify(read.mock.calls.map(([, params]) => params))).not.toContain(award.sourceActionId!);
      read.mockClear();
      expect((await loader.extend({ identities: [{ factType: 'ledger_entry', factId: award.id }] })).groups).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('keeps root and reverse date pairs exact while completing overlapping selector kinds independently', async () => {
    const second = '2026-09-08' as LogicalDate; const otherId = uuid(500) as BoardId;
    const base = parseCoinPolicy(bonusFixture.reconciliationCases[0].actions[0].policyJson);
    const pairs = [[boardId, date], [boardId, second], [otherId, date], [otherId, second]] as const;
    const rows = pairs.map(([rootId, logicalDate], n) => action(n + 1, { boardId: uuid(501) as BoardId,
      logicalDate, policyJson: canonicalCoinPolicy({ ...base, rootId, requiredBoardIds: [rootId] }),
    }));
    for (const row of rows) await appendHabitAction(h.db, row);
    await h.db.withExclusiveTransactionAsync(async tx => {
      const loader = await createRemoteFactLoader({ tx, sourceHashing: h.deps.hashing }, []);
      const roots = [{ rootId: boardId, logicalDate: date }, { rootId: otherId, logicalDate: second }];
      const rootResult = await loader.extend({ rootScopes: [...roots, ...roots].reverse() });
      expect(rootResult.groups.map(group => group.accepted!.fact!.value)).toEqual([rows[0], rows[3]]);
      expect(rootResult.completed.rootScopes).toHaveLength(2);
      const reverse = roots.map(({ rootId, logicalDate }) => ({ boardId: rootId, logicalDate }));
      const reverseResult = await loader.extend({ reverseScopes: [...reverse, ...reverse] });
      expect(reverseResult.groups).toEqual([]);
      expect(reverseResult.completed.reverseScopes).toEqual(reverse);
      const read = jest.spyOn(h.db, 'getAllAsync');
      expect(await loader.extend({ rootScopes: roots, reverseScopes: reverse })).toEqual({ groups: [], completed: emptyCompleted });
      expect(read).not.toHaveBeenCalled();
    });
  });

  it('keeps a malformed extension failure sticky before any later reads', async () => {
    const loader = await createRemoteFactLoader({ tx: h.db, sourceHashing: h.deps.hashing }, []);
    const read = jest.spyOn(h.db, 'getAllAsync');
    const failure = await loader.extend({ identities: [{ factType: 'habit_action', factId: 'invalid' }] }).catch(cause => cause);
    expect(failure.reason).toBe('envelope');
    await expect(loader.extend({ identities: [identity(action(1))] })).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
  });
});
