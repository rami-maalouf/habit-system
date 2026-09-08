import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/bonus-coins.json';
import { bonusAwardRow, bonusPolicyFingerprint, bonusReversalRow } from '@/core/domain/bonus-coin-causes';
import { parseCoinPolicy } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, LogicalDate } from '@/core/domain/ids';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

describe('bonus cause canonical bytes', () => {
  it.each(fixture.encodingCases)('$name', async vector => {
    const scope = { rootId: vector.scope.rootId as BoardId, logicalDate: vector.scope.logicalDate as LogicalDate };
    const source = vector.sourceAction as HabitAction;
    const policy = parseCoinPolicy(vector.effectivePolicyJson);
    expect(await bonusPolicyFingerprint(policy, hashing)).toBe(vector.expectedBonusPolicyFingerprint);
    const award = await bonusAwardRow(scope, source, policy, hashing);
    expect(award).toEqual(vector.expectedAwardRow);
    expect(await bonusReversalRow(vector.removalAction as HabitAction, award, hashing)).toEqual(vector.expectedReversalRow);
    expect(award.createdAt).toBe(source.createdAt);
    expect(policy.bonusClosesAtUtc).not.toBe(parseCoinPolicy(source.policyJson!).bonusClosesAtUtc);
  });
});
