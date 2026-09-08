import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/bonus-coins.json';
import { replayBonusCoins } from '@/core/domain/bonus-coins';
import type { BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import type { HabitAction } from '@/core/domain/habit-actions';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

describe('bonus replay', () => {
  it.each(fixture.replayCases)('$name', async vector => {
    const actions = vector.actions as HabitAction[];
    const expected = { scopeKey: `bonus:${vector.scope.rootId}:${vector.scope.logicalDate}`,
      ordinaryRows: vector.expectedOrdinaryRows, target: vector.expectedTarget };
    expect(await replayBonusCoins(vector.scope as BonusCoinScope, actions, hashing)).toEqual(expected);
    expect(await replayBonusCoins(vector.scope as BonusCoinScope, [...actions].reverse(), hashing)).toEqual(expected);
    expect(await replayBonusCoins(vector.scope as BonusCoinScope, [...actions, ...actions], hashing)).toEqual(expected);
  });
});
