import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { reconcileCheckCoins } from '@/core/domain/coin-reconciliation';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CheckCoinScope } from '@/core/domain/coins';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

describe('immutable check coin reconciliation', () => {
  it('corrects locally valid cap-race awards using actual replay and literal complete provenance', async () => {
    const vector = fixture.correction;
    const result = await reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[], vector.existingRows as CoinLedgerRow[], hashing);
    expect(result).toEqual({ appendedRows: vector.expectedAppend, target: vector.target, balance: vector.balance });
    const replay = await reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[],
      [...vector.existingRows, ...result.appendedRows] as CoinLedgerRow[], hashing);
    expect(replay).toEqual({ appendedRows: [], target: 1, balance: 1 });
  });

  it('cancels overlapping proofs once and appends one full-union correction independent of delivery order', async () => {
    const vector = fixture.overlap;
    for (const existing of [vector.existingRows, [...vector.existingRows].reverse()]) {
      const result = await reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[], existing as CoinLedgerRow[], hashing);
      expect(result).toEqual({ appendedRows: vector.expectedAppend, target: 1, balance: 1 });
      expect(await reconcileCheckCoins(fixture.scope as CheckCoinScope, [...vector.actions].reverse() as HabitAction[],
        [...existing, ...result.appendedRows, ...result.appendedRows] as CoinLedgerRow[], hashing))
        .toEqual({ appendedRows: [], target: 1, balance: 1 });
    }
  });

  it('waits for complete proof facts and refuses a correction with altered payload', async () => {
    const vector = fixture.correction;
    await expect(reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[],
      [vector.existingRows[0], ...vector.expectedAppend] as CoinLedgerRow[], hashing)).rejects.toMatchObject({ reason: 'missing' });
    await expect(reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[],
      [...vector.existingRows, { ...vector.expectedAppend[0], delta: -2 }] as CoinLedgerRow[], hashing)).rejects.toMatchObject({ reason: 'invalid' });
  });
  it.each(fixture.rejectedReconciliations)('matches shared invalid or incomplete native proof rejection $reason', async (vector) => {
    await expect(reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[], vector.rows as CoinLedgerRow[], hashing))
      .rejects.toMatchObject({ reason: vector.reason });
  });
  it('matches the native full-set zero correction case', async () => {
    const vector = fixture.zeroCorrection;
    expect(await reconcileCheckCoins(fixture.scope as CheckCoinScope, vector.actions as HabitAction[], vector.existingRows as CoinLedgerRow[], hashing))
      .toEqual({ appendedRows: vector.expectedAppend, target: 1, balance: 1 });
  });
});
