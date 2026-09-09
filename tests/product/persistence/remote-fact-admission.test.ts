import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { Hashing } from '@/core/domain/ports';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import type { RemoteFactCandidate } from '@/core/domain/remote-fact-validation';
import { admitRemoteFacts, type RemoteFactAdmissionInput } from '@/core/persistence/remote-fact-admission';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { readRemoteFactInbox } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const candidate = (factType: RemoteFactCandidate['factType'], value: HabitAction | CoinLedgerRow,
  enqueueOnAdmission = false): RemoteFactCandidate => ({ factType, factId: value.id, value, enqueueOnAdmission });

describe('atomic source-neutral immutable admission', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  const admit = (candidates: RemoteFactCandidate[] = []) => h.db.withExclusiveTransactionAsync(tx =>
    admitRemoteFacts(tx, { candidates, acquiredNow: 500 }, h.deps.hashing));
  const queue = () => h.db.getAllAsync('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox ORDER BY id');

  it('settles the literal genuine check and reaches a no-op fixed point without echoing its source', async () => {
    const result = await admit([candidate('habit_action', source)]);
    expect(result.admitted).toEqual([{ factType: 'habit_action', factId: source.id, mutationStamp: source.mutationStamp }]);
    expect(result.generated).toEqual([{ factType: 'ledger_entry', factId: award.id, mutationStamp: award.mutationStamp }]);
    expect(result.duplicates).toEqual([]);
    expect(result.affected).toEqual({ checkScopes: [{ boardId: source.boardId, logicalDate: source.logicalDate }], rootScopes: [] });
    expect(result.localChanged).toBe(true);
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([source]);
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await queue()).toEqual([{ entity_type: 'ledger_entry', entity_id: award.id,
      mutation_stamp: award.mutationStamp, created_at: 500 }]);
    const replay = await admit([candidate('habit_action', source)]);
    expect(replay.admitted).toEqual([]);
    expect(replay.generated).toEqual([]);
    expect(replay.duplicates).toEqual([{ factType: 'habit_action', factId: source.id }]);
    expect(replay.localChanged).toBe(false);
    expect((await admit()).localChanged).toBe(false);
    expect(await queue()).toHaveLength(1);
  });

  it.each([false, true])('promotes a pending received award with saved restore intent %s without relabeling it generated', async intent => {
    const staged = await admit([candidate('ledger_entry', award, intent)]);
    expect(staged.admitted).toEqual([]);
    expect(staged.generated).toEqual([]);
    expect(staged.counts).toMatchObject({ pending: 1, blocked: 0, quarantined: 0 });
    expect(await getLedgerEntry(h.db, award.id)).toBeNull();
    expect(await queue()).toEqual([]);
    const result = await admit([candidate('habit_action', source)]);
    expect(result.admitted).toEqual(expect.arrayContaining([
      { factType: 'habit_action', factId: source.id, mutationStamp: source.mutationStamp },
      { factType: 'ledger_entry', factId: award.id, mutationStamp: award.mutationStamp },
    ]));
    expect(result.admitted).toHaveLength(2);
    expect(result.generated).toEqual([]);
    expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 0 });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await readRemoteFactInbox(h.db)).toEqual([]);
    expect(await queue()).toEqual(intent ? [{ entity_type: 'ledger_entry', entity_id: award.id,
      mutation_stamp: award.mutationStamp, created_at: 500 }] : []);
    expect((await admit()).localChanged).toBe(false);
  });

  it.each([false, true])('classifies the whole action group before promotion in a fresh database, reversed %s', async reversed => {
    const other = { ...source, createdAt: source.createdAt + 1 };
    const values = reversed ? [other, source] : [source, other];
    const result = await admit(values.map(value => candidate('habit_action', value)));
    expect(result.admitted).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 2 });
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([]);
    expect(await getLedgerEntry(h.db, award.id)).toBeNull();
    expect(await queue()).toEqual([]);
  });

  it('does not let a later third variant revive a previously conflicted action identity', async () => {
    await admit([source, { ...source, createdAt: source.createdAt + 1 }].map(value => candidate('habit_action', value)));
    const third = await admit([candidate('habit_action', { ...source, createdAt: source.createdAt + 2 })]);
    expect(third.admitted).toEqual([]);
    expect(third.counts).toMatchObject({ quarantined: 3 });
    expect(await queue()).toEqual([]);
  });

  it('supports an explicit empty root settlement seed without introducing a check, baseline or queue entry', async () => {
    const scope = { rootId: source.boardId, logicalDate: source.logicalDate };
    const result = await h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx,
      { candidates: [], acquiredNow: 0, rootScopes: [scope] }, h.deps.hashing));
    expect(result).toMatchObject({ admitted: [], generated: [], duplicates: [], localChanged: false,
      affected: { checkScopes: [], rootScopes: [scope] } });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it.each([
    { acquiredNow: -0 },
    { acquiredNow: -1 },
    { acquiredNow: Infinity },
    { checkScopes: [{ boardId: 'bad', logicalDate: source.logicalDate }] },
    { checkScopes: [{ boardId: source.boardId, logicalDate: '2026-02-30' }] },
    { rootScopes: [{ rootId: 'bad', logicalDate: source.logicalDate }] },
    { rootScopes: [{ rootId: source.boardId, logicalDate: 3 }] },
    { checkpoint: true },
    { candidates: [{ factType: 'unknown', factId: source.id, value: source, enqueueOnAdmission: false }] },
  ])('rejects invalid caller options before storage or hashing: %j', async overrides => {
    const reads = jest.spyOn(h.db, 'getAllAsync');
    const first = jest.spyOn(h.db, 'getFirstAsync');
    const writes = jest.spyOn(h.db, 'runAsync');
    const hashing = { sha1: jest.fn(h.deps.hashing.sha1), sha256: jest.fn(h.deps.hashing.sha256) };
    await expect(h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx,
      { candidates: [], acquiredNow: 500, ...overrides } as RemoteFactAdmissionInput, hashing)))
      .rejects.toMatchObject({ reason: 'envelope' });
    expect(reads).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(hashing.sha1).not.toHaveBeenCalled();
    expect(hashing.sha256).not.toHaveBeenCalled();
  });

  it('retains exactly one operation wrapper if capturing a provider method itself fails', async () => {
    const original = new RemoteFactHashingError({ provider: 'original' });
    const provider = { sha256: h.deps.hashing.sha256 };
    Object.defineProperty(provider, 'sha1', { get() { throw original; } });
    const reads = jest.spyOn(h.db, 'getAllAsync');
    const failure = await h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx,
      { candidates: [], acquiredNow: 500 }, provider as Hashing)).catch(cause => cause);
    expect(failure).toBeInstanceOf(RemoteFactHashingError);
    expect(failure).not.toBe(original);
    expect(failure.cause).toBe(original);
    expect(reads).not.toHaveBeenCalled();
  });
});
