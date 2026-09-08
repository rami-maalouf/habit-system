import { currentLogicalDate } from '@/core/calendar/logical-date';
import type { ActivityPeriodRange } from '@/core/calendar/periods';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { assignRuns, type StackRunEvidence } from '@/core/domain/stack-runs';
import type { DerivedStack } from '@/core/domain/stacks';
import calendar from '@/core/domain/fixtures/stack-calendar.json';

const a = '00000000-0000-4000-8000-000000000001' as BoardId;
const b = '00000000-0000-4000-8000-000000000002' as BoardId;
const optional = '00000000-0000-4000-8000-000000000003' as BoardId;
const d = (date: string) => date as LogicalDate;
const stack: DerivedStack = {
  rootId: a, rootStartOfDayMinute: 0, orderedMemberIds: [b, a, optional], activeMemberIds: [b, a, optional],
  requiredMemberIds: [a, b], usualStartMinute: 1425,
};
const open: ActivityPeriodRange[] = [{ startDate: d('2026-09-01'), endDate: null }];
function evidence(today = '2026-09-10'): StackRunEvidence {
  return {
    today: d(today), periodsByBoard: new Map([[a, open], [b, open], [optional, open]]),
    countsByBoard: new Map(),
  };
}

describe('exact-date stack runs', () => {
  it('does not combine Tuesday evening and Wednesday morning, regardless of display hints', () => {
    const input = { ...evidence(), countsByBoard: new Map([
      [a, new Map([[d('2026-09-08'), 1]])], [b, new Map([[d('2026-09-09'), 1]])],
    ]) };
    const dates = [d('2026-09-08'), d('2026-09-09')];
    expect(assignRuns(stack, dates, input)).toEqual([
      { rootId: a, logicalDate: dates[0], runKey: `${a}|${dates[0]}`, requiredBoardIds: [a, b], checkedRequiredBoardIds: [a], complete: false },
      { rootId: a, logicalDate: dates[1], runKey: `${a}|${dates[1]}`, requiredBoardIds: [a, b], checkedRequiredBoardIds: [b], complete: false },
    ]);
    expect(assignRuns({ ...stack, usualStartMinute: 0 }, dates, input)).toEqual(assignRuns(stack, dates, input));
  });

  it('counts each required eligible member once, sorts ids, and never changes readonly evidence', () => {
    const date = d('2026-09-08');
    const input = { ...evidence(), countsByBoard: new Map([
      [a, new Map([[date, 7]])], [b, new Map([[date, 3]])], [optional, new Map([[date, 25]])],
    ]) };
    const before = JSON.stringify([...input.countsByBoard].map(([boardId, counts]) => [boardId, [...counts]]));
    const frozen = Object.freeze({ ...stack, requiredMemberIds: Object.freeze([b, a]) });
    expect(assignRuns(frozen, Object.freeze([date]), input)).toEqual([{
      rootId: a, logicalDate: date, runKey: `${a}|${date}`, requiredBoardIds: [a, b], checkedRequiredBoardIds: [a, b], complete: true,
    }]);
    expect(JSON.stringify([...input.countsByBoard].map(([boardId, counts]) => [boardId, [...counts]]))).toBe(before);
    expect(frozen.requiredMemberIds).toEqual([b, a]);
  });

  it('keeps optional-only, absent-evidence, nonpositive counts, and empty requests incomplete', () => {
    const date = d('2026-09-08');
    const input = { ...evidence(), countsByBoard: new Map([[optional, new Map([[date, 10]])], [a, new Map([[date, 0]])], [b, new Map([[date, -1]])]]) };
    expect(assignRuns(stack, [date], input)[0]).toMatchObject({ checkedRequiredBoardIds: [], complete: false });
    expect(assignRuns({ ...stack, requiredMemberIds: [] }, [date], input)[0]).toMatchObject({ requiredBoardIds: [], checkedRequiredBoardIds: [], complete: false });
    expect(assignRuns(stack, [date], { ...input, periodsByBoard: new Map() })[0]).toMatchObject({ requiredBoardIds: [], complete: false });
    expect(assignRuns(stack, [], input)).toEqual([]);
  });

  it('uses exclusive archive dates and open restore dates durably, without consulting current archived display', () => {
    const periods = [
      { startDate: d('2026-09-02'), endDate: d('2026-09-05') },
      { startDate: d('2026-09-08'), endDate: null },
    ];
    const dates = ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05', '2026-09-07', '2026-09-08', '2026-09-09'].map(d);
    const input = { ...evidence('2026-09-08'), periodsByBoard: new Map([[a, periods], [b, periods]]), countsByBoard: new Map([[a, new Map(dates.map((date) => [date, 1]))], [b, new Map(dates.map((date) => [date, 1]))]]) };
    const runs = assignRuns(stack, dates, input);
    expect(runs.map((run) => run.complete)).toEqual([false, true, true, false, false, true, false]);
    expect(assignRuns({ ...stack, activeMemberIds: [] }, dates, input)).toEqual(runs);
    const later = assignRuns(stack, dates, { ...input, today: d('2026-10-01') });
    expect(later.slice(0, -1)).toEqual(runs.slice(0, -1));
    expect(later.at(-1)?.complete).toBe(true);
  });

  it('does not require a same-date closed zero-length period until it reopens', () => {
    const date = d('2026-09-08');
    const single = { ...stack, requiredMemberIds: [a] };
    const countsByBoard = new Map([[a, new Map([[date, 1]])]]);
    expect(assignRuns(single, [date], { ...evidence(), countsByBoard, periodsByBoard: new Map([[a, [{ startDate: date, endDate: date }]]]) })[0])
      .toMatchObject({ requiredBoardIds: [], complete: false });
    expect(assignRuns(single, [date], { ...evidence(), countsByBoard, periodsByBoard: new Map([[a, [{ startDate: date, endDate: null }]]]) })[0])
      .toMatchObject({ requiredBoardIds: [a], complete: true });
  });

  it('uses the root horizon when a member own day has advanced already', () => {
    const now = Date.parse('2026-09-08T06:00:00Z');
    const rootToday = currentLogicalDate(now, 'America/New_York', 240);
    expect(rootToday).toBe('2026-09-07');
    expect(currentLogicalDate(now, 'America/New_York', 0)).toBe('2026-09-08');
    const date = d('2026-09-08');
    expect(assignRuns({ ...stack, rootStartOfDayMinute: 240 }, [date], {
      ...evidence(), today: rootToday, countsByBoard: new Map([[a, new Map([[date, 1]])], [b, new Map([[date, 1]])]]),
    })[0]).toMatchObject({ requiredBoardIds: [], complete: false });
  });

  it.each(calendar.cases)('retains exact checked dates through the shared $id calendar boundary', (fixture) => {
    const selected = { ...stack, rootStartOfDayMinute: fixture.rootStartOfDayMinute };
    const today = currentLogicalDate(Date.parse(fixture.nowUtc), fixture.timeZoneId, selected.rootStartOfDayMinute);
    expect(today).toBe(fixture.today);
    const dates = fixture.storedDates.map(d);
    const counts = new Map(dates.map((date) => [date, 1]));
    const before = [...counts];
    const input: StackRunEvidence = {
      today, periodsByBoard: new Map([[a, [{ startDate: d('2020-01-01'), endDate: null }]], [b, [{ startDate: d('2020-01-01'), endDate: null }]]]),
      countsByBoard: new Map([[a, counts], [b, counts]]),
    };
    const runs = assignRuns(selected, dates, input);
    expect(runs.filter((run) => run.complete).map((run) => run.logicalDate)).toEqual(fixture.completeDates);
    expect(runs.map((run) => run.runKey)).toEqual(fixture.storedDates.map((date) => `${a}|${date}`));
    expect([...counts]).toEqual(before);
  });
});
