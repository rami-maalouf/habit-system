import type { BonusCoinScope } from './bonus-coin-causes';
import { replayBonusCoins } from './bonus-coins';
import { prepareBonusActions } from './bonus-evidence';
import { validateBonusOrdinary } from './bonus-validation';
import type { CoinLedgerRow } from './coin-ledger';
import { reconcileCoinEvidence } from './coin-reconciliation-core';
import type { HabitAction } from './habit-actions';
import type { Hashing } from './ports';

export async function reconcileBonusCoins(scope: BonusCoinScope, inputActions: readonly HabitAction[], inputRows: readonly CoinLedgerRow[], hashing: Hashing) {
  const actions = await prepareBonusActions(scope, inputActions, hashing);
  return reconcileCoinEvidence({
    scopeKey: `bonus:${scope.rootId}:${scope.logicalDate}`, logicalDate: scope.logicalDate, awardKind: 'run_bonus',
    replay: evidence => replayBonusCoins(scope, evidence, hashing),
    validateOrdinary: (evidence, rows) => validateBonusOrdinary(scope, evidence, rows, hashing),
  }, actions, inputRows, hashing);
}
