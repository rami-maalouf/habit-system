import fixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy, COIN_POLICY_BYTES, parseCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance, coinDigest } from '@/core/domain/coin-provenance';
import { uuidV5 } from '@/core/domain/deterministic-ids';
import { canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, LedgerEntryId, LogicalDate } from '@/core/domain/ids';
import { readOpenBoardPolicyDates } from '@/core/persistence/repositories/board-policy-evidence';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const root = fixture.scope.boardId as BoardId;
const outside = '00000000-0000-4000-8000-000000009999' as BoardId;
const date = fixture.scope.logicalDate as LogicalDate;
const now = 1788900000000;
const bonus = fixture.shapeRows.find(row => row.kind === 'run_bonus')! as CoinLedgerRow;

describe('sparse prospective policy evidence', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  const read = (boardIds = [root], rootIds = [root]) => readOpenBoardPolicyDates(h.db, h.deps.hashing, { boardIds, rootIds, now });
  function action(close = now + 1, boardId = root): HabitAction {
    const original = fixture.cases[0].actions[0] as HabitAction;
    return { ...original, boardId, policyJson: canonicalCoinPolicy({ ...parseCoinPolicy(original.policyJson!),
      rootId: root, requiredBoardIds: [root], bonusClosesAtUtc: close, bonusEnabled: true }) };
  }

  it('selects open affected dates and ignores closed and unrelated carriers without domain writes', async () => {
    await appendHabitAction(h.db, action());
    await appendHabitAction(h.db, { ...action(now), id: '00000000-0000-4000-8000-000000000002' as HabitAction['id'], logicalDate: '2026-09-07' as LogicalDate });
    await appendHabitAction(h.db, { ...action(now + 1, outside), id: '00000000-0000-4000-8000-000000000003' as HabitAction['id'], logicalDate: '2026-09-06' as LogicalDate });
    const before = await h.db.getAllAsync('SELECT * FROM habit_actions');
    const writes = jest.spyOn(h.db, 'runAsync');
    expect(await read()).toEqual([date]);
    expect(writes).not.toHaveBeenCalled();
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual(before);
    expect(await read([], [])).toEqual([]);
  });

  it('resolves a bonus source from outside the current component and deduplicates references', async () => {
    const source = action(now + 1, outside);
    await appendHabitAction(h.db, source);
    await appendLedgerEntry(h.db, bonus);
    const proof = canonicalCoinProvenance([
      ['habit_action', source.id, await coinDigest(canonicalHabitAction(source), h.deps.hashing)],
      ['ledger_entry', bonus.id, await coinDigest(canonicalCoinLedger(bonus), h.deps.hashing)],
    ]);
    const adjustment = fixture.correction.expectedAppend[0] as CoinLedgerRow;
    await appendLedgerEntry(h.db, { ...adjustment, scopeKey: bonus.scopeKey, provenanceJson: proof });
    const reads = jest.spyOn(h.db, 'getAllAsync');
    expect(await read()).toEqual([date]);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('validates a closed bonus source instead of treating a missing source as closed', async () => {
    await appendLedgerEntry(h.db, bonus);
    await expect(read()).rejects.toThrow('missing');
    await appendHabitAction(h.db, action(now));
    expect(await read()).toEqual([]);
  });

  it('rejects mismatched proof hashes even when the source is closed', async () => {
    const source = action(now);
    await appendHabitAction(h.db, source);
    await appendLedgerEntry(h.db, bonus);
    const adjustment = fixture.correction.expectedAppend[0] as CoinLedgerRow;
    await appendLedgerEntry(h.db, { ...adjustment, scopeKey: bonus.scopeKey,
      provenanceJson: canonicalCoinProvenance([['habit_action', source.id, '0'.repeat(64)]]) });
    await expect(read()).rejects.toThrow('invalid');
  });

  it('terminates cyclic row references without treating them as complete evidence', async () => {
    await appendHabitAction(h.db, action());
    const a = '00000000-0000-5000-8000-000000000001' as LedgerEntryId;
    const b = '00000000-0000-5000-8000-000000000002' as LedgerEntryId;
    const reversal = fixture.cases[2].ordinaryRows[1] as CoinLedgerRow;
    await appendLedgerEntry(h.db, { ...reversal, id: a, scopeKey: bonus.scopeKey, sourceActionId: bonus.sourceActionId, reversesId: b });
    await appendLedgerEntry(h.db, { ...reversal, id: b, scopeKey: bonus.scopeKey, sourceActionId: bonus.sourceActionId, reversesId: a });
    await expect(read()).rejects.toThrow('invalid');
  });

  it.each(['-9007199254740992', '-0'])('rejects unsafe signed close metadata before classifying it as closed: %s', async close => {
    const row = action();
    const policy = row.policyJson!.replace(/"bonusClosesAtUtc":\d+/, `"bonusClosesAtUtc":${close}`);
    await h.db.runAsync(`INSERT INTO habit_actions (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.commandId, root, date, row.checkInId, row.kind, row.createdAt, row.mutationStamp, policy]);
    await expect(read()).rejects.toThrow('invalid');
  });

  it('rejects adjustment facts with matching hashes in ordinary correction provenance', async () => {
    const source = action();
    await appendHabitAction(h.db, source);
    const proof = canonicalCoinProvenance([['habit_action', source.id, await coinDigest(canonicalHabitAction(source), h.deps.hashing)]]);
    const inner = { ...fixture.correction.expectedAppend[0], scopeKey: bonus.scopeKey, provenanceJson: proof } as CoinLedgerRow;
    await appendLedgerEntry(h.db, inner);
    const outerProof = canonicalCoinProvenance([['ledger_entry', inner.id, await coinDigest(canonicalCoinLedger(inner), h.deps.hashing)]]);
    await appendLedgerEntry(h.db, { ...inner, id: '00000000-0000-5000-8000-000000008888' as LedgerEntryId, provenanceJson: outerProof });
    await expect(read()).rejects.toThrow('invalid');
  });

  it('rejects a reversal target outside the exact economic scope and date', async () => {
    const prior = '2026-09-07' as LogicalDate;
    await appendHabitAction(h.db, { ...action(), logicalDate: prior });
    const cause = fixture.cases[2].actions[0] as HabitAction;
    await appendHabitAction(h.db, { ...cause, policyJson: action().policyJson });
    await appendLedgerEntry(h.db, { ...bonus, logicalDate: prior, scopeKey: `bonus:${root}:${prior}`, runKey: `${root}|${prior}` });
    await appendLedgerEntry(h.db, { ...fixture.cases[2].ordinaryRows[1], scopeKey: bonus.scopeKey, reversesId: bonus.id } as CoinLedgerRow);
    await expect(read()).rejects.toThrow('invalid');
  });

  it('rejects a direct source action from another stored date', async () => {
    await appendHabitAction(h.db, { ...action(), logicalDate: '2026-09-07' as LogicalDate });
    await appendLedgerEntry(h.db, bonus);
    await expect(read()).rejects.toThrow('invalid');
  });

  it.each(['missing', 'wrong-scope'])('resolves ordinary row references in bulk and rejects %s evidence', async kind => {
    const source = action();
    await appendHabitAction(h.db, source);
    const target = { ...bonus, scopeKey: `bonus:${outside}:${date}`, runKey: `${outside}|${date}` };
    if (kind === 'wrong-scope') await appendLedgerEntry(h.db, target);
    await appendLedgerEntry(h.db, { ...fixture.cases[2].ordinaryRows[1], scopeKey: bonus.scopeKey,
      sourceActionId: source.id, reversesId: target.id } as CoinLedgerRow);
    await expect(read()).rejects.toThrow(kind === 'missing' ? 'missing' : 'invalid');
  });

  it.each([null, fixture.cases[0].actions[0].policyJson])('keeps an unknown bonus horizon visible for legacy/null-root source %s', async policyJson => {
    await appendHabitAction(h.db, { ...action(), boardId: outside, policyJson });
    await appendLedgerEntry(h.db, bonus);
    expect(await read()).toEqual([date]);
  });

  it('follows ordinary proof links and reuses a cancellation proof without losing a closed horizon', async () => {
    const source = action(now);
    await appendHabitAction(h.db, source);
    await appendLedgerEntry(h.db, bonus);
    const proof = canonicalCoinProvenance([['ledger_entry', bonus.id, await coinDigest(canonicalCoinLedger(bonus), h.deps.hashing)]]);
    const reconciliationKey = await coinDigest(proof, h.deps.hashing);
    const adjustment: CoinLedgerRow = { ...fixture.correction.expectedAppend[0] as CoinLedgerRow,
      id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'adjustment', bonus.scopeKey, reconciliationKey]), h.deps.hashing) as LedgerEntryId,
      scopeKey: bonus.scopeKey, provenanceJson: proof, reconciliationKey };
    await appendLedgerEntry(h.db, adjustment);
    await appendLedgerEntry(h.db, { ...adjustment, id: await uuidV5(`cancel:${adjustment.id}`, h.deps.hashing) as LedgerEntryId,
      delta: -adjustment.delta, adjustsId: adjustment.id });
    expect(await read()).toEqual([]);
  });

  it('keeps a scope with no captured close conservatively visible', async () => {
    const proof = canonicalCoinProvenance([]);
    await appendLedgerEntry(h.db, { ...fixture.correction.expectedAppend[0], scopeKey: bonus.scopeKey,
      provenanceJson: proof, reconciliationKey: await coinDigest(proof, h.deps.hashing) } as CoinLedgerRow);
    expect(await read()).toEqual([date]);
  });

  it('rejects an oversized open policy before allocating any prospective facts', async () => {
    const row = action();
    const policy = JSON.stringify({ ...JSON.parse(row.policyJson!), oversized: 'x'.repeat(COIN_POLICY_BYTES) });
    await h.db.runAsync(`INSERT INTO habit_actions (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.commandId, root, date, row.checkInId, row.kind, row.createdAt, row.mutationStamp, policy]);
    await expect(read()).rejects.toThrow('size');
  });

  it.each(['{bad', '{}', '{"rootId":"root","bonusClosesAtUtc":"closed"}'])('selects malformed close metadata for validation: %s', async policy => {
    const row = action();
    await h.db.runAsync(`INSERT INTO habit_actions (id, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.commandId, root, date, row.checkInId, row.kind, row.createdAt, row.mutationStamp, policy]);
    await expect(read()).rejects.toThrow('invalid');
  });
});
