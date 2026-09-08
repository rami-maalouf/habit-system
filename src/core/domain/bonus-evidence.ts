import { isValidLogicalDate } from '../calendar/logical-date';
import type { BonusCoinScope } from './bonus-coin-causes';
import { CoinContractError, parseCoinPolicy } from './coin-policy';
import { compareCoinTuple } from './coin-provenance';
import { baselineAction, canonicalHabitAction, validateHabitAction, type HabitAction } from './habit-actions';
import { isUuidV4 } from './ids';
import type { Hashing } from './ports';

export function compareBonusActions(a: HabitAction, b: HabitAction): number {
  return Number(a.kind !== 'baseline') - Number(b.kind !== 'baseline') || compareCoinTuple([a.mutationStamp, a.id], [b.mutationStamp, b.id]);
}

// ordinary cause recovery precedes the membership envelope when a control is missing.
export async function prepareBonusActions(scope: BonusCoinScope, input: readonly HabitAction[], hashing: Hashing): Promise<HabitAction[]> {
  if (typeof scope.rootId !== 'string' || !isUuidV4(scope.rootId) ||
    typeof scope.logicalDate !== 'string' || !isValidLogicalDate(scope.logicalDate)) throw new CoinContractError('invalid');
  const actions = new Map<string, HabitAction>();
  for (const action of input) {
    const validated = validateHabitAction(action);
    if (!validated.ok) throw new CoinContractError(validated.error.code === 'capacity' ? 'size' : 'invalid');
    if (action.logicalDate !== scope.logicalDate || Object.is(action.createdAt, -0)) throw new CoinContractError('invalid');
    const prior = actions.get(action.id);
    if (prior && canonicalHabitAction(prior) !== canonicalHabitAction(action)) throw new CoinContractError('invalid');
    if (action.kind === 'baseline' && canonicalHabitAction(action) !== canonicalHabitAction(await baselineAction({
      id: action.checkInId!, boardId: action.boardId, logicalDate: action.logicalDate,
    }, hashing))) throw new CoinContractError('invalid');
    actions.set(action.id, action);
  }
  return [...actions.values()].sort(compareBonusActions);
}

export function assertBonusEnvelope(scope: BonusCoinScope, actions: readonly HabitAction[]): void {
  const members = new Set([scope.rootId]);
  for (const action of actions) {
    const policy = action.policyJson === null ? null : parseCoinPolicy(action.policyJson);
    if (policy?.rootId === scope.rootId) {
      members.add(action.boardId);
      for (const id of policy.requiredBoardIds) members.add(id as typeof scope.rootId);
    }
  }
  if (actions.some(action => !members.has(action.boardId))) throw new CoinContractError('invalid');
}
