import { bonusAwardRow, bonusReversalRow, type BonusCoinScope } from './bonus-coin-causes';
import { assertBonusEnvelope, prepareBonusActions } from './bonus-evidence';
import type { CoinLedgerRow } from './coin-ledger';
import { parseCoinPolicy, type CoinPolicy } from './coin-policy';
import type { HabitAction } from './habit-actions';
import type { Hashing } from './ports';

type HeldBonus = { row: CoinLedgerRow; policy: CoinPolicy; witnesses: Map<string, Set<string>> };

export async function replayBonusCoins(scope: BonusCoinScope, input: readonly HabitAction[], hashing: Hashing) {
  const actions = await prepareBonusActions(scope, input, hashing);
  assertBonusEnvelope(scope, actions);
  const active = new Map<string, Set<string>>();
  const tokens = (boardId: string) => {
    let value = active.get(boardId);
    if (!value) { value = new Set(); active.set(boardId, value); }
    return value;
  };
  const complete = (policy: CoinPolicy) => policy.requiredBoardIds.length > 0 &&
    policy.requiredBoardIds.every(id => tokens(id).size > 0);
  let control: CoinPolicy | null = null;
  let held: HeldBonus | null = null;
  const ordinaryRows: CoinLedgerRow[] = [];
  for (const action of actions) {
    const observed = action.policyJson === null ? null : parseCoinPolicy(action.policyJson);
    if (action.kind === 'policy') {
      if (action.boardId === scope.rootId && observed?.rootId === scope.rootId) control = observed;
      continue;
    }
    const state = tokens(action.boardId);
    if (action.kind === 'uncheck' || action.kind === 'move_out') {
      if (action.checkInId === null) state.clear(); else state.delete(action.checkInId);
      const witnesses = held?.witnesses.get(action.boardId);
      if (held && witnesses && action.createdAt < held.policy.bonusClosesAtUtc!) {
        const eligible = action.checkInId === null || witnesses.has(action.checkInId);
        if (action.checkInId === null) witnesses.clear(); else witnesses.delete(action.checkInId);
        if (eligible && state.size === 0) {
          ordinaryRows.push(await bonusReversalRow(action, held.row, hashing));
          held = null;
        }
      }
      continue;
    }
    const policy = control ?? (observed?.rootId === scope.rootId ? observed : null);
    const wasComplete = policy === null ? false : complete(policy);
    const added = !state.has(action.checkInId!);
    state.add(action.checkInId!);
    if (added) held?.witnesses.get(action.boardId)?.add(action.checkInId!);
    if (!held && action.kind === 'check' && observed !== null && added && policy?.bonusEnabled &&
      policy.requiredBoardIds.includes(action.boardId) && !wasComplete && complete(policy)) {
      const row = await bonusAwardRow(scope, action, policy, hashing);
      ordinaryRows.push(row);
      held = { row, policy, witnesses: new Map(policy.requiredBoardIds.map(id => [id, new Set(tokens(id))])) };
    }
  }
  return { scopeKey: `bonus:${scope.rootId}:${scope.logicalDate}`, ordinaryRows, target: held === null ? 0 : 1 };
}
