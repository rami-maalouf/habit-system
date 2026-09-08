import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/bonus-coins.json';
import type { BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { replayBonusCoins } from '@/core/domain/bonus-coins';
import { reconcileBonusCoins } from '@/core/domain/bonus-reconciliation';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

describe('bonus reconciliation', () => {
  it.each(fixture.reconciliationCases)('$name', async vector => {
    const scope = vector.scope as BonusCoinScope;
    const actions = vector.actions as HabitAction[];
    const rows = vector.rows as CoinLedgerRow[];
    const expected = { appendedRows: vector.expectedAppendedRows, target: vector.expectedTarget, balance: vector.expectedBalance };
    expect(await reconcileBonusCoins(scope, actions, rows, hashing)).toEqual(expected);
    expect(await reconcileBonusCoins(scope, [...actions].reverse(), [...rows].reverse(), hashing)).toEqual(expected);
    expect(await reconcileBonusCoins(scope, [...actions, ...actions], [...rows, ...rows], hashing)).toEqual(expected);
    expect(await reconcileBonusCoins(scope, actions, [...rows, ...vector.expectedAppendedRows] as CoinLedgerRow[], hashing))
      .toEqual({ ...expected, appendedRows: [] });
  });

  it.each(fixture.errorCases)('$name', async vector => {
    const scope = vector.scope as BonusCoinScope;
    const actions = vector.actions as HabitAction[];
    const result = vector.operation === 'replay' ? replayBonusCoins(scope, actions, hashing) :
      reconcileBonusCoins(scope, actions, vector.rows as CoinLedgerRow[], hashing);
    await expect(result).rejects.toMatchObject({ name: 'CoinContractError', reason: vector.expectedReason });
  });
});
