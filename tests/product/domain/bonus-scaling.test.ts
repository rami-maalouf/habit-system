import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/bonus-coins.json';
import { bonusAwardRow, type BonusCoinScope } from '@/core/domain/bonus-coin-causes';
import { reconcileBonusCoins } from '@/core/domain/bonus-reconciliation';
import { canonicalCoinPolicy, parseCoinPolicy } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CommandId, HabitActionId } from '@/core/domain/ids';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

it('reuses candidate causes when many partial awards share one genuine source', async () => {
  const vector = fixture.encodingCases[0];
  const scope = vector.scope as BonusCoinScope;
  const count = 128;
  const policy = parseCoinPolicy(vector.effectivePolicyJson);
  const controls = Array.from({ length: count }, (_, index): HabitAction => ({
    ...vector.policySourceAction as HabitAction,
    id: `50000000-0000-4000-8000-${String(index).padStart(12, '0')}` as HabitActionId,
    commandId: `60000000-0000-4000-8000-${String(index).padStart(12, '0')}` as CommandId,
    mutationStamp: `20260908120000-${String(index).padStart(5, '0')}-fixture`,
    policyJson: canonicalCoinPolicy({ ...policy, bonusClosesAtUtc: policy.bonusClosesAtUtc! + index * 1000 }),
  }));
  const source = { ...vector.sourceAction as HabitAction, mutationStamp: '20260908120000-09999-fixture',
    policyJson: canonicalCoinPolicy({ ...policy, rootId: null, requiredBoardIds: [], bonusClosesAtUtc: null, bonusEnabled: false }) };
  const first = fixture.replayCases[1].actions[0] as HabitAction;
  const rows = await Promise.all(controls.map(control => bonusAwardRow(scope, source, parseCoinPolicy(control.policyJson!), hashing)));
  let digests = 0;
  const measured = { ...hashing, sha256: async (bytes: Uint8Array) => { digests += 1; return hashing.sha256(bytes); } };
  const result = await reconcileBonusCoins(scope, [first, ...controls, source], rows, measured);
  expect(result.target).toBe(1);
  expect(result.balance).toBe(1);
  expect(result.appendedRows).toHaveLength(1);
  expect(result.appendedRows[0].delta).toBe(1 - count);
  expect(digests).toBeLessThan(count * 4 + 10);
});
