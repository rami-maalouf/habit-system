import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/bonus-coins.json';
import type { BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { replayBonusCoins } from '@/core/domain/bonus-coins';
import { reconcileBonusCoins } from '@/core/domain/bonus-reconciliation';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { COIN_POLICY_BYTES } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};
const vector = fixture.reconciliationCases[1];
const scope = vector.scope as BonusCoinScope;
const actions = vector.actions as HabitAction[];
const rows = vector.rows as CoinLedgerRow[];

describe('bonus evidence boundaries', () => {
  it('keeps oversized evidence distinct from malformed evidence', async () => {
    await expect(replayBonusCoins(scope, [{ ...actions[0], policyJson: ' '.repeat(COIN_POLICY_BYTES + 1) }], hashing))
      .rejects.toMatchObject({ reason: 'size' });
  });

  it('rejects negative zero on legacy null-policy evidence', async () => {
    await expect(replayBonusCoins(scope, [{ ...actions[0], policyJson: null, createdAt: -0 }], hashing))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  it('does not mutate frozen actions, rows, or caller order', async () => {
    const frozenActions = Object.freeze([...actions].reverse().map(action => Object.freeze({ ...action })));
    const frozenRows = Object.freeze([...rows].reverse().map(row => Object.freeze({ ...row })));
    const before = JSON.stringify({ frozenActions, frozenRows });
    expect(await reconcileBonusCoins(Object.freeze(scope), frozenActions, frozenRows, hashing))
      .toEqual({ appendedRows: vector.expectedAppendedRows, target: 1, balance: 1 });
    expect(JSON.stringify({ frozenActions, frozenRows })).toBe(before);
  });

  it('uses separate HLC and id tuple fields when device suffixes share a prefix', async () => {
    const example = fixture.replayCases[2];
    const check = { ...example.actions[1], mutationStamp: '20260908120000-00002-a' } as HabitAction;
    const removal = { ...example.actions[2], mutationStamp: '20260908120000-00002-aa' } as HabitAction;
    const result = await replayBonusCoins(scope, [removal, example.actions[0] as HabitAction, check], hashing);
    expect(result.target).toBe(0);
    expect(result.ordinaryRows.map(row => row.sourceActionId)).toEqual([check.id, removal.id]);
  });
});
