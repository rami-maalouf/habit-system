import { currentStreak, longestStreak } from '../analytics/streaks';
import { addDays, startOfIsoWeek } from '../calendar/logical-date';
import type { BoardKind } from './entities';
import type { BoardId, LogicalDate } from './ids';
import { assignRuns, isStackDateEligible } from './stack-runs';
import type { StackRun, StackRunEvidence } from './stack-runs';
import type { DerivedStack } from './stacks';

export type StackRunProgress = {
  logicalDate: LogicalDate;
  requiredCount: number;
  checkedRequiredCount: number;
  available: boolean;
  complete: boolean;
};

export type StackHeatmapCell = StackRunProgress & {
  state: 'unavailable' | 'none' | 'some' | 'most' | 'all';
};

export type StackHistoryMetrics = {
  currentRun: StackRunProgress;
  completeRunsThisWeek: number;
  currentStreak: number;
  longestStreak: number;
};

function progress(run: StackRun): StackRunProgress {
  return {
    logicalDate: run.logicalDate,
    requiredCount: run.requiredBoardIds.length,
    checkedRequiredCount: run.checkedRequiredBoardIds.length,
    available: run.requiredBoardIds.length > 0,
    complete: run.complete,
  };
}

export function analyzeStackHistory(stack: Readonly<DerivedStack>, evidence: StackRunEvidence): StackHistoryMetrics {
  // only a date with recorded checks can be complete, even for ancient periods.
  const candidates = new Set<LogicalDate>();
  for (const id of stack.orderedMemberIds) {
    for (const [date, count] of evidence.countsByBoard.get(id) ?? []) {
      if (count > 0 && date <= evidence.today) candidates.add(date);
    }
  }
  const completed = new Set(assignRuns(stack, [...candidates].sort(), evidence)
    .filter((run) => run.complete).map((run) => run.logicalDate));
  const weekStart = startOfIsoWeek(evidence.today);
  return {
    currentRun: progress(assignRuns(stack, [evidence.today], evidence)[0]),
    completeRunsThisWeek: [...completed].filter((date) => date >= weekStart).length,
    currentStreak: currentStreak(completed, evidence.today),
    longestStreak: longestStreak(completed),
  };
}

export function stackHeatmap(stack: Readonly<DerivedStack>, evidence: StackRunEvidence): StackHeatmapCell[] {
  const dates = Array.from({ length: 365 }, (_, index) => addDays(evidence.today, index - 364));
  return assignRuns(stack, dates, evidence).map((run) => {
    const cell = progress(run);
    const state = !cell.available ? 'unavailable' : cell.complete ? 'all' :
      cell.checkedRequiredCount === 0 ? 'none' :
        cell.checkedRequiredCount * 2 <= cell.requiredCount ? 'some' : 'most';
    return { ...cell, state };
  });
}

export function memberChecksThisWeek(boardId: BoardId, kind: BoardKind, evidence: StackRunEvidence): number {
  const weekStart = startOfIsoWeek(evidence.today);
  const periods = evidence.periodsByBoard.get(boardId) ?? [];
  let total = 0;
  for (let date = weekStart; date <= evidence.today; date = addDays(date, 1)) {
    const count = evidence.countsByBoard.get(boardId)?.get(date) ?? 0;
    if (count > 0 && isStackDateEligible(date, periods, evidence.today)) {
      total += kind === 'daily' ? 1 : count;
    }
  }
  return total;
}
