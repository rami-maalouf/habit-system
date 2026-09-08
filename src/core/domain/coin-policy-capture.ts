import { isValidLogicalDate } from '../calendar/logical-date';
import type { ActivityPeriodRange } from '../calendar/periods';
import type { SqlExecutor } from '../persistence/database';
import { listUndeletedBoards } from '../persistence/repositories/boards';
import { readCoinPolicyPeriods } from '../persistence/repositories/coin-policy-context';
import { canonicalCoinPolicy, CoinContractError, type CoinPolicy } from './coin-policy';
import type { Board } from './entities';
import { isUuidV4, type BoardId, type LogicalDate } from './ids';
import { err, ok, type DomainResult } from './result';
import { isStackDateEligible } from './stack-runs';
import { deriveStacks, type DerivedStack, type StackBoard } from './stacks';

export type CoinPolicyBoard = Readonly<StackBoard & Pick<Board, 'kind' | 'earnsCoins' | 'coinCapPerDay'>>;
export type CoinPolicyContext = {
  readonly boards: readonly CoinPolicyBoard[];
  readonly periodsByBoard: ReadonlyMap<BoardId, readonly Readonly<ActivityPeriodRange>[]>;
};
export type CoinPolicyCapture = (subject: { boardId: BoardId; logicalDate: LogicalDate }) => DomainResult<CoinPolicy>;
type CloseResolver = (date: LogicalDate, startMinute: number) => number;
type Topology = {
  boards: ReadonlyMap<BoardId, CoinPolicyBoard>;
  stacksByBoard: ReadonlyMap<BoardId, DerivedStack>;
};

function prepareTopology(boards: readonly CoinPolicyBoard[]): DomainResult<Topology> {
  const snapshot = boards.map((board) => ({ ...board }));
  // preset times only serve the topology adapter; display hints never enter policy.
  const stacks = deriveStacks(snapshot, { wake: 0, lunch: 0, dinner: 0, sleep: 0 });
  if (!stacks.ok) return stacks;
  const stacksByBoard = new Map<BoardId, DerivedStack>();
  for (const stack of stacks.value) {
    for (const boardId of stack.orderedMemberIds) stacksByBoard.set(boardId, stack);
  }
  return ok({ boards: new Map(snapshot.filter((board) => board.deletedAt === null).map((board) => [board.id, board])), stacksByBoard });
}

function captureFromSnapshot(
  topology: Topology,
  periodsByBoard: CoinPolicyContext['periodsByBoard'],
  resolveClose: CloseResolver,
): DomainResult<CoinPolicyCapture> {
  for (const ranges of periodsByBoard.values()) {
    if (ranges.some((range) => typeof range.startDate !== 'string' || !isValidLogicalDate(range.startDate) ||
      (range.endDate !== null && (typeof range.endDate !== 'string' || !isValidLogicalDate(range.endDate))))) {
      return err('validation', 'Coin policy needs valid activity periods.', { field: 'coins' });
    }
  }
  const periods = new Map([...periodsByBoard].map(([id, ranges]) => [id, ranges.map((range) => ({ ...range }))]));
  return ok(({ boardId, logicalDate }) => {
    if (typeof boardId !== 'string' || !isUuidV4(boardId) || typeof logicalDate !== 'string' || !isValidLogicalDate(logicalDate)) {
      return err('validation', 'Coin policy needs a valid habit and stored date.', { field: 'coins' });
    }
    const board = topology.boards.get(boardId);
    if (!board) return err('not_found', 'The habit is outside this policy snapshot.');
    const stack = topology.stacksByBoard.get(boardId);
    // immutable action dates can lead the displayed root date; no today horizon applies.
    const requiredBoardIds = stack ? stack.requiredMemberIds.filter((id) =>
      isStackDateEligible(logicalDate, periods.get(id) ?? [], logicalDate)) : [];
    try {
      const policy: CoinPolicy = {
        version: 1,
        boardKind: board.kind,
        earnsCoins: board.earnsCoins,
        coinCapPerDay: board.coinCapPerDay,
        checkClosesAtUtc: resolveClose(logicalDate, board.startOfDayMinute),
        rootId: stack?.rootId ?? null,
        requiredBoardIds,
        bonusClosesAtUtc: stack ? resolveClose(logicalDate, stack.rootStartOfDayMinute) : null,
        bonusEnabled: requiredBoardIds.length > 0,
      };
      canonicalCoinPolicy(policy);
      return ok(policy);
    } catch (error) {
      if (error instanceof CoinContractError && error.reason === 'size') {
        return err('capacity', 'Coin policy exceeds the supported record size.', { retryable: true });
      }
      if (error instanceof RangeError || error instanceof CoinContractError) {
        return err('validation', 'The captured coin policy or day boundary is invalid.', { field: 'coins' });
      }
      throw error;
    }
  });
}

// prospective edits prepare a new snapshot; repeated captures reuse this topology.
export function prepareCoinPolicyCapture(
  context: CoinPolicyContext,
  resolveClose: CloseResolver,
): DomainResult<CoinPolicyCapture> {
  const topology = prepareTopology(context.boards);
  return topology.ok ? captureFromSnapshot(topology.value, context.periodsByBoard, resolveClose) : topology;
}

// the caller owns the transaction and resolver. only fully loaded components can capture.
export async function readCoinPolicyCapture(
  tx: SqlExecutor,
  boardIds: readonly BoardId[],
  resolveClose: CloseResolver,
): Promise<DomainResult<CoinPolicyCapture>> {
  if (boardIds.length === 0) return prepareCoinPolicyCapture({ boards: [], periodsByBoard: new Map() }, resolveClose);
  if (boardIds.some((id) => typeof id !== 'string' || !isUuidV4(id))) {
    return err('validation', 'Coin policy needs valid habit ids.', { field: 'coins' });
  }
  const topology = prepareTopology(await listUndeletedBoards(tx));
  if (!topology.ok) return topology;
  const ids = new Set<BoardId>();
  for (const boardId of boardIds) {
    if (!topology.value.boards.has(boardId)) return err('not_found', 'A requested habit no longer exists.');
    for (const memberId of topology.value.stacksByBoard.get(boardId)?.orderedMemberIds ?? [boardId]) ids.add(memberId);
  }
  const scopedTopology: Topology = {
    boards: new Map([...topology.value.boards].filter(([id]) => ids.has(id))),
    stacksByBoard: topology.value.stacksByBoard,
  };
  const periods = await readCoinPolicyPeriods(tx, [...ids].sort());
  return captureFromSnapshot(scopedTopology, periods, resolveClose);
}
