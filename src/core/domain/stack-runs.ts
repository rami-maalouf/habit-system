import { compareLogicalDates } from '../calendar/logical-date';
import type { ActivityPeriodRange } from '../calendar/periods';
import type { BoardId, LogicalDate } from './ids';
import type { DerivedStack } from './stacks';

export type StackRunEvidence = {
  readonly today: LogicalDate;
  readonly periodsByBoard: ReadonlyMap<BoardId, readonly ActivityPeriodRange[]>;
  readonly countsByBoard: ReadonlyMap<BoardId, ReadonlyMap<LogicalDate, number>>;
};

export type StackRun = {
  rootId: BoardId;
  logicalDate: LogicalDate;
  runKey: `${BoardId}|${LogicalDate}`;
  requiredBoardIds: BoardId[];
  checkedRequiredBoardIds: BoardId[];
  complete: boolean;
};

// stack membership ends on the stored archive date; individual habit metrics
// retain their inherited inclusive period boundary.
export function isStackDateEligible(
  date: LogicalDate,
  periods: readonly ActivityPeriodRange[],
  today: LogicalDate,
): boolean {
  if (compareLogicalDates(date, today) > 0) return false;
  return periods.some((period) => compareLogicalDates(date, period.startDate) >= 0 &&
    (period.endDate === null || compareLogicalDates(date, period.endDate) < 0));
}

export function assignRuns(
  stack: Readonly<DerivedStack>,
  dates: readonly LogicalDate[],
  evidence: StackRunEvidence,
): StackRun[] {
  const requiredMembers = [...stack.requiredMemberIds].sort();
  return dates.map((logicalDate) => {
    const requiredBoardIds = requiredMembers.filter((boardId) =>
      isStackDateEligible(logicalDate, evidence.periodsByBoard.get(boardId) ?? [], evidence.today));
    const checkedRequiredBoardIds = requiredBoardIds.filter((boardId) =>
      (evidence.countsByBoard.get(boardId)?.get(logicalDate) ?? 0) > 0);
    return {
      rootId: stack.rootId, logicalDate, runKey: `${stack.rootId}|${logicalDate}`,
      requiredBoardIds, checkedRequiredBoardIds,
      complete: requiredBoardIds.length > 0 && checkedRequiredBoardIds.length === requiredBoardIds.length,
    };
  });
}
