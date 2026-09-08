import * as calendar from '@/core/calendar/logical-date';
import type { ActivityPeriodRange } from '@/core/calendar/periods';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { analyzeStackHistory, stackHeatmap, memberChecksThisWeek } from '@/core/domain/stack-analytics';
import type { StackRunEvidence } from '@/core/domain/stack-runs';
import type { DerivedStack } from '@/core/domain/stacks';

const a = '00000000-0000-4000-8000-000000000001' as BoardId;
const b = '00000000-0000-4000-8000-000000000002' as BoardId;
const c = '00000000-0000-4000-8000-000000000003' as BoardId;
const d = (date: string) => date as LogicalDate;
const stack: DerivedStack = { rootId: a, rootStartOfDayMinute: 0, orderedMemberIds: [a, b, c], activeMemberIds: [a, b, c], requiredMemberIds: [a, b], usualStartMinute: 0 };
const open: ActivityPeriodRange[] = [{ startDate: d('2020-01-01'), endDate: null }];
function evidence(today: string, completed: string[] = []): StackRunEvidence {
  return { today: d(today), periodsByBoard: new Map([[a, open], [b, open], [c, open]]), countsByBoard: new Map([
    [a, new Map(completed.map((date) => [d(date), 1]))], [b, new Map(completed.map((date) => [d(date), 1]))],
  ]) };
}

describe('stack analytics', () => {
  it('uses the root ISO week across a year boundary and keeps the prior streak while today is unfinished', () => {
    const input = evidence('2026-01-01', ['2025-12-10', '2025-12-11', '2025-12-12', '2025-12-13', '2025-12-14', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02']);
    const result = analyzeStackHistory(stack, input);
    expect(result).toEqual({
      currentRun: { logicalDate: d('2026-01-01'), requiredCount: 2, checkedRequiredCount: 0, available: true, complete: false },
      completeRunsThisWeek: 3, currentStreak: 4, longestStreak: 5,
    });
    expect(analyzeStackHistory(stack, { ...input, countsByBoard: new Map([...input.countsByBoard].reverse().map(([id, counts]) => [id, new Map([...counts].reverse())])) })).toEqual(result);
  });

  it('breaks streaks on unavailable archive dates and never counts optional-only or empty-required days', () => {
    const input = evidence('2026-01-01', ['2025-12-29', '2025-12-30', '2025-12-31']);
    const periods: ActivityPeriodRange[] = [{ startDate: d('2020-01-01'), endDate: d('2025-12-31') }];
    const closed = { ...input, periodsByBoard: new Map([[a, periods], [b, periods]]) };
    expect(analyzeStackHistory(stack, closed)).toEqual({
      currentRun: { logicalDate: d('2026-01-01'), requiredCount: 0, checkedRequiredCount: 0, available: false, complete: false },
      completeRunsThisWeek: 2, currentStreak: 0, longestStreak: 2,
    });
    expect(analyzeStackHistory({ ...stack, requiredMemberIds: [] }, input)).toMatchObject({ completeRunsThisWeek: 0, currentStreak: 0, longestStreak: 0 });
    expect(analyzeStackHistory(stack, { ...input, countsByBoard: new Map([[c, new Map([[d('2026-01-01'), 5]])]]) }))
      .toMatchObject({ completeRunsThisWeek: 0, currentStreak: 0, longestStreak: 0 });
  });

  it('returns exactly 365 meaningful dates including leap day and all five availability/intensity states', () => {
    const input = evidence('2028-03-01');
    const four = { ...stack, orderedMemberIds: [a, b, c, 'four' as BoardId], requiredMemberIds: [a, b, c, 'four' as BoardId] };
    const ids = four.requiredMemberIds;
    const periods: ActivityPeriodRange[] = [{ startDate: d('2028-02-25'), endDate: null }];
    const countsByBoard = new Map(ids.map((id, index) => [id, new Map([
      ...(index === 0 ? [[d('2028-02-26'), 2] as const] : []),
      ...(index < 2 ? [[d('2028-02-27'), 1] as const] : []),
      ...(index < 3 ? [[d('2028-02-28'), 1] as const] : []),
      [d('2028-02-29'), 1] as const,
    ])]));
    const cells = stackHeatmap(four, { ...input, periodsByBoard: new Map(ids.map((id) => [id, periods])), countsByBoard });
    expect(cells).toHaveLength(365);
    expect(cells[0].logicalDate).toBe('2027-03-03');
    expect(cells.at(-1)?.logicalDate).toBe('2028-03-01');
    expect(cells.slice(-7).map(({ logicalDate, state, requiredCount, checkedRequiredCount }) => ({ logicalDate, state, requiredCount, checkedRequiredCount }))).toEqual([
      { logicalDate: '2028-02-24', state: 'unavailable', requiredCount: 0, checkedRequiredCount: 0 },
      { logicalDate: '2028-02-25', state: 'none', requiredCount: 4, checkedRequiredCount: 0 },
      { logicalDate: '2028-02-26', state: 'some', requiredCount: 4, checkedRequiredCount: 1 },
      { logicalDate: '2028-02-27', state: 'some', requiredCount: 4, checkedRequiredCount: 2 },
      { logicalDate: '2028-02-28', state: 'most', requiredCount: 4, checkedRequiredCount: 3 },
      { logicalDate: '2028-02-29', state: 'all', requiredCount: 4, checkedRequiredCount: 4 },
      { logicalDate: '2028-03-01', state: 'none', requiredCount: 4, checkedRequiredCount: 0 },
    ]);
    expect(cells.filter((cell) => cell.complete).map((cell) => cell.logicalDate)).toEqual(['2028-02-29']);
  });

  it('counts Daily dates once and Count records within the root ISO week and exclusive periods', () => {
    const input = evidence('2026-01-01');
    const counts = new Map([['2025-12-28', 9], ['2025-12-29', 3], ['2025-12-30', 2], ['2025-12-31', 8], ['2026-01-01', 5], ['2026-01-02', 7]].map(([date, count]) => [d(date as string), count as number]));
    const periods = [{ startDate: d('2025-12-29'), endDate: d('2025-12-31') }, { startDate: d('2026-01-01'), endDate: null }];
    const data = { ...input, countsByBoard: new Map([[a, counts]]), periodsByBoard: new Map([[a, periods]]) };
    expect(memberChecksThisWeek(a, 'daily', data)).toBe(3);
    expect(memberChecksThisWeek(a, 'count', data)).toBe(10);
    expect(memberChecksThisWeek(b, 'count', data)).toBe(0);
    expect(memberChecksThisWeek(a, 'count', { ...data, periodsByBoard: new Map() })).toBe(0);
  });

  it('evaluates sparse checked history without traversing centuries of empty period dates', () => {
    const input = evidence('2026-09-08', ['2026-09-07', '2026-09-08']);
    const old = [{ startDate: d('0001-01-01'), endDate: null }];
    const calls = jest.spyOn(calendar, 'addDays');
    try {
      expect(analyzeStackHistory(stack, { ...input, periodsByBoard: new Map([[a, old], [b, old]]) }))
        .toMatchObject({ completeRunsThisWeek: 2, currentStreak: 2, longestStreak: 2 });
      expect(calls.mock.calls.length).toBeLessThan(100);
    } finally { calls.mockRestore(); }
  });
});
