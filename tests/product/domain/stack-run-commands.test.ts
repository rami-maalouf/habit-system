import { currentLogicalDate } from '@/core/calendar/logical-date';
import { isDateEligible } from '@/core/calendar/periods';
import { archiveBoard, createBoard, createCheckIn, restoreBoard, updateBoard, type CreateBoardInput } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { assignRuns, isStackDateEligible } from '@/core/domain/stack-runs';
import { deriveStacks } from '@/core/domain/stacks';
import { getBoardById, listUndeletedBoards } from '@/core/persistence/repositories/boards';
import { allDailyCounts } from '@/core/persistence/repositories/check-ins';
import { listBoardPeriods } from '@/core/persistence/repositories/support';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const d = (date: string) => date as LogicalDate;
const presets = { wake: 420, lunch: 720, dinner: 1080, sleep: 1380 };
const fields = {
  title: 'Stack habit', symbol: 'star.fill', accentHex: '#70A7FF', tracksAmount: false,
  tracksTime: true, usesTintedBackground: false, startOfDayMinute: 0, metricsEnabled: true,
};

async function snapshot(h: TestHarness) {
  const tables = ['boards', 'check_ins', 'habit_actions', 'board_activity_periods', 'app_settings', 'mutation_outbox', 'command_receipts', 'widget_board_rows'];
  return Promise.all(tables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

describe('stack runs from persisted command evidence', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  async function board(extra: Partial<CreateBoardInput> = {}) {
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...extra });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }
  async function check(boardId: BoardId, date: string, instant = h.clock.utcMs) {
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, logicalDate: d(date), occurredAtUtc: instant, note: 'preserved history', source: 'app' });
    expect(result.ok).toBe(true);
  }
  async function runs(dates: string[]) {
    return h.db.withTransactionAsync(async (tx) => {
      const boards = await listUndeletedBoards(tx);
      const result = deriveStacks(boards, presets);
      if (!result.ok) throw new Error(result.error.message);
      const stack = result.value[0];
      const periodsByBoard = new Map(await Promise.all(boards.map(async (row) => [row.id, await listBoardPeriods(tx, row.id)] as const)));
      const countsByBoard = new Map(await Promise.all(boards.map(async (row) => [row.id, new Map([...await allDailyCounts(tx, row.id)].map(([date, count]) => [d(date), count]))] as const)));
      return assignRuns(stack, dates.map(d), {
        today: currentLogicalDate(h.clock.utcMs, h.clock.zone, stack.rootStartOfDayMinute), periodsByBoard, countsByBoard,
      });
    });
  }

  it('excludes the stored archive date durably while retaining inherited individual-habit eligibility and history', async () => {
    const root = await board();
    const child = await board({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    h.clock.utcMs = Date.parse('2026-09-08T16:00:00Z');
    await check(root, '2026-09-08');
    await check(child, '2026-09-07');
    expect((await runs(['2026-09-08']))[0]).toMatchObject({ requiredBoardIds: [root, child], complete: false });
    const history = await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id');
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    const periods = await listBoardPeriods(h.db, child);
    expect(periods).toMatchObject([{ startDate: '2026-08-30', endDate: '2026-09-08' }]);
    expect(isDateEligible(d('2026-09-08'), periods, d('2026-09-08'))).toBe(true);
    expect(isStackDateEligible(d('2026-09-08'), periods, d('2026-09-08'))).toBe(false);
    const before = await snapshot(h);
    const archived = await runs(['2026-09-08']);
    expect(archived[0]).toMatchObject({ requiredBoardIds: [root], complete: true });
    h.clock.advanceDays(4);
    expect(await runs(['2026-09-08'])).toEqual(archived);
    expect(await snapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id')).toEqual(history);
  });

  it('same-day restore reopens the actual period and immediately requires that member again', async () => {
    const root = await board();
    const child = await board({ anchor: { kind: 'board', relation: 'before', boardId: root } });
    h.clock.utcMs = Date.parse('2026-09-08T16:00:00Z');
    await check(root, '2026-09-08');
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    expect((await runs(['2026-09-08']))[0].complete).toBe(true);
    expect((await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    expect(await listBoardPeriods(h.db, child)).toMatchObject([{ startDate: '2026-08-30', endDate: null }]);
    expect((await runs(['2026-09-08']))[0]).toMatchObject({ requiredBoardIds: [root, child], complete: false });
    await check(child, '2026-09-08');
    const before = await snapshot(h);
    expect((await runs(['2026-09-08']))[0].complete).toBe(true);
    expect(await snapshot(h)).toEqual(before);
  });

  it('uses only grouped stored dates for timed checks and keeps retained Daily duplicate history binary', async () => {
    const root = await board({ usualTimeMinute: 1380 });
    const child = await board({ anchor: { kind: 'board', relation: 'after', boardId: root }, usualTimeMinute: 420 });
    h.clock.utcMs = Date.parse('2026-09-10T16:00:00Z');
    await check(root, '2026-09-08', Date.parse('2026-09-09T03:30:00Z'));
    await check(child, '2026-09-09', Date.parse('2026-09-09T11:00:00Z'));
    expect((await runs(['2026-09-08', '2026-09-09'])).map((run) => run.complete)).toEqual([false, false]);
    await check(child, '2026-09-08', Date.parse('2026-09-10T01:00:00Z'));
    await check(child, '2026-09-08', Date.parse('2026-09-08T16:00:00Z'));
    const history = await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id');
    const boardRow = (await getBoardById(h.db, child))!;
    expect((await updateBoard(h.deps, { ...boardRow, boardId: child, commandId: h.ids.nextCommandId(), expectedMutationStamp: boardRow.mutationStamp, kind: 'daily' })).ok).toBe(true);
    const before = await snapshot(h);
    expect((await runs(['2026-09-08']))[0]).toMatchObject({ requiredBoardIds: [root, child], checkedRequiredBoardIds: [root, child], complete: true });
    expect(await snapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id')).toEqual(history);
  });

  it('honors a member stored archive date even when it differs from the root current date', async () => {
    const root = await board({ startOfDayMinute: 0 });
    const child = await board({ anchor: { kind: 'board', relation: 'after', boardId: root }, startOfDayMinute: 240 });
    h.clock.utcMs = Date.parse('2026-09-08T06:00:00Z');
    await check(root, '2026-09-07');
    await check(root, '2026-09-08');
    expect(currentLogicalDate(h.clock.utcMs, h.clock.zone, 240)).toBe('2026-09-07');
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    expect(await listBoardPeriods(h.db, child)).toMatchObject([{ endDate: '2026-09-07' }]);
    expect((await runs(['2026-09-07', '2026-09-08'])).map((run) => run.complete)).toEqual([true, true]);
  });
});
