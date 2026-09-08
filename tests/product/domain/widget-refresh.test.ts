import fixture from '@/core/automations/fixtures/widget-refresh.json';
import { archiveBoard, createBoard, createCheckIn, toggleDailyCheckIn, updateBoard } from '@/core/domain/commands';
import { currentLogicalDate } from '@/core/calendar/logical-date';
import * as calendar from '@/core/calendar/logical-date';
import type { BoardId } from '@/core/domain/ids';
import type { WidgetBoardRow } from '@/core/domain/entities';
import { getCheckInById } from '@/core/persistence/repositories/check-ins';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { readWidgetRows } from '@/core/persistence/projections/widget-rows';
import { refreshWidgetProjection } from '@/core/domain/widget-projection';
import { nextWidgetRefreshUtc, widgetPropsFromProjection } from '@/features/widgets/widget-props';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

async function board(h: TestHarness, kind: 'count' | 'daily' = 'daily', startOfDayMinute = 0): Promise<BoardId> {
  const result = await createBoard(h.deps, {
    commandId: h.ids.nextCommandId(), title: `${kind} widget`, kind, symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

describe('widget timeline contract', () => {
  it('terminates with a bounded refresh deadline if wall-clock conversion stops advancing', () => {
    const stalled = jest.spyOn(calendar, 'localWallClock').mockReturnValue({ year: 2026, month: 8, day: 30, hour: 0, minute: 0 });
    try {
      const now = Date.UTC(2026, 7, 30);
      expect(nextWidgetRefreshUtc(now, 'UTC')).toBe(now + 48 * 60 * 60 * 1000);
    } finally {
      stalled.mockRestore();
    }
  });

  for (const entry of fixture.boundaryCases) {
    it(`expires at ${entry.name}`, () => {
      expect(nextWidgetRefreshUtc(entry.nowUtcMs, entry.timeZoneId, entry.startMinutes))
        .toBe(entry.expectedExpiresAtUtc);
    });
  }

  for (const entry of fixture.propsCases) {
    it(`publishes ${entry.name} without changing the source projection`, () => {
      const row = entry.row as WidgetBoardRow;
      const before = JSON.stringify(row);
      expect(widgetPropsFromProjection([row])).toEqual({ rows: [entry.expected], stale: false });
      expect(JSON.stringify(row)).toBe(before);
    });
  }
});

async function evidence(h: TestHarness) {
  const tables = ['boards', 'check_ins', 'habit_actions', 'command_receipts', 'app_settings', 'mutation_outbox'];
  return Promise.all(tables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

describe('atomic widget cache refresh', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('rebuilds yesterday\'s cached Daily and Count rows without creating mutation evidence', async () => {
    const dailyId = await board(h, 'count');
    const countId = await board(h, 'count');
    for (const boardId of [dailyId, countId]) {
      for (const note of ['first preserved note', 'second preserved note']) {
        expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app', note })).toMatchObject({ ok: true });
      }
    }
    const stored = await getBoardById(h.db, dailyId);
    if (!stored) throw new Error('missing board');
    expect(await updateBoard(h.deps, { ...stored, commandId: h.ids.nextCommandId(), boardId: dailyId, expectedMutationStamp: stored.mutationStamp, kind: 'daily' })).toMatchObject({ ok: true });
    // simulate a still-persisted pre-t7 daily projection, including duplicate counts.
    await h.db.runAsync('UPDATE widget_board_rows SET strip = ? WHERE board_id = ?', ['[0,0,0,0,0,0,2]', dailyId]);
    h.clock.advanceDays(1);
    const before = await evidence(h);
    const result = await refreshWidgetProjection(h.deps);
    expect(result).toMatchObject({ ok: true, value: {
      generatedAtUtc: h.clock.utcMs, expiresAtUtc: Date.UTC(2026, 8, 1, 4),
      rows: [
        { boardId: dailyId, kind: 'daily', strip: [0, 0, 0, 0, 0, 1, 0], stripEndDate: '2026-08-31' },
        { boardId: countId, kind: 'count', strip: [0, 0, 0, 0, 0, 2, 0], stripEndDate: '2026-08-31' },
      ],
    } });
    expect(await evidence(h)).toEqual(before);
    expect(result.ok && result.value.rows).toEqual(await readWidgetRows(h.db));
  });

  for (const entry of fixture.boundaryCases) {
    it(`refreshes actual checked dates across ${entry.name}`, async () => {
      h.clock.utcMs = entry.nowUtcMs;
      h.clock.zone = entry.timeZoneId;
      const starts = entry.startMinutes.length ? entry.startMinutes : [0];
      const ids = [];
      for (const start of starts) {
        const boardId = await board(h, 'daily', start);
        ids.push(boardId);
        expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app' })).toMatchObject({ ok: true });
      }
      const initial = await refreshWidgetProjection(h.deps);
      expect(initial).toMatchObject({ ok: true, value: { generatedAtUtc: entry.nowUtcMs, expiresAtUtc: entry.expectedExpiresAtUtc } });
      h.clock.utcMs = entry.expectedExpiresAtUtc;
      const before = await evidence(h);
      const refreshed = await refreshWidgetProjection(h.deps);
      if (!refreshed.ok) throw new Error(refreshed.error.message);
      for (let index = 0; index < starts.length; index++) {
        const originalDate = currentLogicalDate(entry.nowUtcMs, entry.timeZoneId, starts[index]);
        const currentDate = currentLogicalDate(h.clock.utcMs, entry.timeZoneId, starts[index]);
        const row = refreshed.value.rows[index];
        expect(row.boardId).toBe(ids[index]);
        expect(row.stripEndDate).toBe(currentDate);
        expect(row.strip[6]).toBe(originalDate === currentDate ? 1 : 0);
      }
      expect(refreshed.value.expiresAtUtc).toBeGreaterThan(h.clock.utcMs);
      expect(await evidence(h)).toEqual(before);
    });
  }

  it('captures time and timezone after queued writers complete and excludes archived boards', async () => {
    const active = await board(h, 'daily', 240);
    const archived = await board(h, 'daily', 30);
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: archived })).toMatchObject({ ok: true });
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const writer = h.db.withExclusiveTransactionAsync(async () => {
      await holding;
      h.clock.utcMs = Date.UTC(2026, 7, 31, 0, 1);
      h.clock.zone = 'UTC';
    });
    const pending = refreshWidgetProjection(h.deps);
    release();
    await writer;
    const result = await pending;
    expect(result).toMatchObject({ ok: true, value: {
      generatedAtUtc: h.clock.utcMs, expiresAtUtc: Date.UTC(2026, 7, 31, 4),
      rows: [{ boardId: active, stripEndDate: '2026-08-30' }],
    } });
    expect(result.ok && result.value.rows).toHaveLength(1);
  });

  it('publishes an empty current snapshot when there are no active boards', async () => {
    const before = await evidence(h);
    expect(await refreshWidgetProjection(h.deps)).toEqual({ ok: true, value: {
      rows: [], generatedAtUtc: h.clock.utcMs, expiresAtUtc: Date.UTC(2026, 7, 31, 4),
    } });
    expect(await evidence(h)).toEqual(before);
  });

  it.each([
    { name: 'error object', failure: new Error('cache insert failed') },
    { name: 'string rejection', failure: 'cache insert failed' },
  ])('rolls back a cache rebuild on storage failure ($name)', async ({ failure }) => {
    await board(h);
    const before = await evidence(h);
    const originalCache = await readWidgetRows(h.db);
    const run = h.db.runAsync.bind(h.db);
    const injected = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => {
      if (sql.startsWith('INSERT INTO widget_board_rows')) return Promise.reject(failure);
      return run(sql, params);
    });
    expect(await refreshWidgetProjection(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true, message: expect.stringContaining('cache insert failed') } });
    injected.mockRestore();
    expect(await readWidgetRows(h.db)).toEqual(originalCache);
    expect(await evidence(h)).toEqual(before);
    expect(await refreshWidgetProjection(h.deps)).toMatchObject({ ok: true });
  });
});

describe('widget toggle provenance', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it.each(['app', 'widget'] as const)('records %s provenance and replays the original creation', async (source) => {
    const boardId = await board(h);
    const commandId = h.ids.nextCommandId();
    const result = await toggleDailyCheckIn(h.deps, {
      commandId, boardId, expectedCheckIns: [], ...(source === 'widget' ? { source } : {}),
    });
    if (!result.ok || !result.value.checkInId) throw new Error('missing toggle creation');
    expect(await getCheckInById(h.db, result.value.checkInId)).toMatchObject({ source });
    expect(await toggleDailyCheckIn(h.deps, { commandId, boardId, source: 'app' })).toEqual(result);
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toHaveLength(1);
  });
});
