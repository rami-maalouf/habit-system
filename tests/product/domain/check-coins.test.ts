import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinPolicy, COIN_RECORD_BYTES, parseCoinPolicy } from '@/core/domain/coin-policy';
import type { CoinPolicy } from '@/core/domain/coin-policy';
import { replayCheckCoins } from '@/core/domain/coins';
import type { HabitAction } from '@/core/domain/habit-actions';
import { baselineAction } from '@/core/domain/habit-actions';
import type { BoardId, LogicalDate } from '@/core/domain/ids';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

describe('shared pure check coin contract', () => {
  it('encodes and parses the exact version1 policy bytes', () => {
    expect(canonicalCoinPolicy(fixture.policy as CoinPolicy)).toBe(fixture.policyJson);
    expect(parseCoinPolicy(fixture.policyJson)).toEqual(fixture.policy);
  });

  it('retains signed economic closes independently from source event time', () => {
    const value = { ...fixture.policy, checkClosesAtUtc: -62_135_596_800_000 } as CoinPolicy;
    expect(parseCoinPolicy(canonicalCoinPolicy(value))).toEqual(value);
  });

  it.each(fixture.cases)('$name with literal generated rows', async (vector) => {
    const result = await replayCheckCoins(fixture.scope as { boardId: BoardId; logicalDate: LogicalDate }, vector.actions as HabitAction[], hashing);
    expect(result).toEqual({ scopeKey: `check:${fixture.scope.boardId}:${fixture.scope.logicalDate}`,
      activeCheckInIds: vector.activeCheckInIds, target: vector.target, ordinaryRows: vector.ordinaryRows });
  });
  it.each(fixture.rejectedReplays)('matches native malformed source rejection $reason', async (vector) => {
    await expect(replayCheckCoins(fixture.scope as { boardId: BoardId; logicalDate: LogicalDate }, vector.actions as HabitAction[], hashing))
      .rejects.toMatchObject({ reason: vector.reason });
  });

  it('validates deterministic baseline identity before retained state can suppress an award', async () => {
    const source = fixture.cases[0].actions[0] as HabitAction;
    const baseline = await baselineAction({ id: source.checkInId!, boardId: source.boardId, logicalDate: source.logicalDate }, hashing);
    const result = await replayCheckCoins(fixture.scope as { boardId: BoardId; logicalDate: LogicalDate }, [baseline, source], hashing);
    expect(result.target).toBe(0);
    await expect(replayCheckCoins(fixture.scope as { boardId: BoardId; logicalDate: LogicalDate },
      [{ ...baseline, id: fixture.cases[0].ordinaryRows[0].id as never }, source], hashing)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects an oversized immutable action before producing a partial award', async () => {
    const source = { ...fixture.cases[0].actions[0], mutationStamp: `01788825600000-00000-${'x'.repeat(COIN_RECORD_BYTES)}` } as HabitAction;
    await expect(replayCheckCoins(fixture.scope as { boardId: BoardId; logicalDate: LogicalDate }, [source], hashing)).rejects.toMatchObject({ reason: 'size' });
  });
  it('rejects malformed scope, action identity and unequal duplicate evidence', async () => {
    const source = fixture.cases[0].actions[0] as HabitAction;
    for (const scope of [{ ...fixture.scope, boardId: [fixture.scope.boardId] }, { ...fixture.scope, logicalDate: '2026-02-30' }]) {
      await expect(replayCheckCoins(scope as never, [], hashing)).rejects.toMatchObject({ reason: 'invalid' });
    }
    for (const change of [{ id: 'bad' }, { boardId: '00000000-0000-4000-8000-000000000099' }, { logicalDate: '2026-09-07' }, { createdAt: -0 }]) {
      await expect(replayCheckCoins(fixture.scope as never, [{ ...source, ...change }] as HabitAction[], hashing)).rejects.toMatchObject({ reason: 'invalid' });
    }
    const baseline = await baselineAction({ id: source.checkInId!, boardId: source.boardId, logicalDate: source.logicalDate }, hashing);
    await expect(replayCheckCoins(fixture.scope as never, [{ ...baseline, policyJson: fixture.policyJson }], hashing)).rejects.toMatchObject({ reason: 'invalid' });
    await expect(replayCheckCoins(fixture.scope as never, [source, { ...source, createdAt: source.createdAt + 1 }], hashing)).rejects.toMatchObject({ reason: 'invalid' });
    expect(await replayCheckCoins(fixture.scope as never, [source, source], hashing)).toEqual(await replayCheckCoins(fixture.scope as never, [source], hashing));
  });
});
