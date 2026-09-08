import { isValidLogicalDate } from '../calendar/logical-date';
import { COIN_RECORD_BYTES, CoinContractError, parseCoinPolicy } from './coin-policy';
import { checkCoinRow } from './coin-ledger';
import type { CoinLedgerRow } from './coin-ledger';
import { baselineAction, canonicalHabitAction, validateHabitAction } from './habit-actions';
import { compareCoinTuple } from './coin-provenance';
import type { HabitAction } from './habit-actions';
import { isUuidV4 } from './ids';
import type { BoardId, LogicalDate } from './ids';
import type { Hashing } from './ports';

export type CheckCoinScope = { boardId: BoardId; logicalDate: LogicalDate };

export function orderedCoinActions(scope: CheckCoinScope, actions: readonly HabitAction[]): HabitAction[] {
  if (typeof scope.boardId !== 'string' || !isUuidV4(scope.boardId) || !isValidLogicalDate(scope.logicalDate)) throw new CoinContractError('invalid');
  const unique = new Map<string, HabitAction>();
  for (const action of actions) {
    if (!validateHabitAction({ ...action, policyJson: null }).ok || action.boardId !== scope.boardId ||
      action.logicalDate !== scope.logicalDate || Object.is(action.createdAt, -0) || (action.kind === 'baseline' && action.policyJson !== null)) throw new CoinContractError('invalid');
    if (action.policyJson !== null) parseCoinPolicy(action.policyJson);
    if (new TextEncoder().encode(canonicalHabitAction(action)).length > COIN_RECORD_BYTES) throw new CoinContractError('size');
    const prior = unique.get(action.id);
    if (prior && canonicalHabitAction(prior) !== canonicalHabitAction(action)) throw new CoinContractError('invalid');
    unique.set(action.id, action);
  }
  return [...unique.values()].sort((a, b) => Number(a.kind !== 'baseline') - Number(b.kind !== 'baseline') ||
    compareCoinTuple([a.mutationStamp, a.id], [b.mutationStamp, b.id]));
}

export async function replayCheckCoins(scope: CheckCoinScope, actions: readonly HabitAction[], hashing: Hashing) {
  const active = new Set<string>();
  const outstanding = new Map<string, { row: CoinLedgerRow; close: number }>();
  const ordinaryRows: CoinLedgerRow[] = [];
  for (const action of orderedCoinActions(scope, actions)) {
    if (action.kind === 'baseline' && canonicalHabitAction(action) !== canonicalHabitAction(await baselineAction({
      id: action.checkInId!, boardId: action.boardId, logicalDate: action.logicalDate,
    }, hashing))) throw new CoinContractError('invalid');
    if (action.kind === 'policy') continue;
    if (action.kind === 'uncheck' || action.kind === 'move_out') {
      for (const [id, award] of outstanding) {
        if ((action.checkInId === null || action.checkInId === award.row.checkInId) && action.createdAt < award.close) {
          ordinaryRows.push(await checkCoinRow(action, hashing, award.row));
          outstanding.delete(id);
        }
      }
      if (action.checkInId === null) active.clear(); else active.delete(action.checkInId);
      continue;
    }
    const policy = action.policyJson === null ? null : parseCoinPolicy(action.policyJson);
    const qualifies = action.kind === 'check' && !active.has(action.checkInId!) &&
      policy?.earnsCoins && (policy.boardKind === 'count' || active.size === 0) && outstanding.size < policy.coinCapPerDay;
    active.add(action.checkInId!);
    if (qualifies) {
      const row = await checkCoinRow(action, hashing);
      ordinaryRows.push(row);
      outstanding.set(action.id, { row, close: policy.checkClosesAtUtc });
    }
  }
  return { scopeKey: `check:${scope.boardId}:${scope.logicalDate}`, activeCheckInIds: [...active].sort(), ordinaryRows, target: outstanding.size };
}
