import fixture from '@/core/calendar/fixtures/hermes-historical.json';
import { currentLogicalDate, localDateOfInstant, localWallClock } from '@/core/calendar/logical-date';
import { createBoard, createCheckIn } from '@/core/domain/commands';

import { createTestHarness } from '../helpers/test-db';

describe('historical dates under the captured Hermes calendar', () => {
  beforeEach(() => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, instant) {
      const captured = fixture.cases.find((item) => item.instant === Number(instant));
      if (this.resolvedOptions().timeZone === fixture.timeZoneId && captured) {
        return captured.parts as Intl.DateTimeFormatPart[];
      }
      return original.call(this, instant);
    });
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it.each(fixture.cases)('keeps the proleptic date $expected despite the runtime civil calendar', (item) => {
    const [year, month, day] = item.expected.split('-').map(Number);
    expect(localWallClock(item.instant, fixture.timeZoneId)).toEqual({ year, month, day, hour: 0, minute: 0 });
    expect(localDateOfInstant(item.instant, fixture.timeZoneId)).toBe(item.expected);
    expect(currentLogicalDate(item.instant, fixture.timeZoneId, 0)).toBe(item.expected);
  });

  it.each([
    [-62162121600000, '0000-02-28'],
    [-62135596800000, '0000-12-31'],
    [-12219724800000, '1582-10-09'],
  ])('applies a shifted start before the historical midnight %s', (instant, expected) => {
    expect(currentLogicalDate(Number(instant), fixture.timeZoneId, 60)).toBe(expected);
  });

  it.each(fixture.cases.filter((item) => item.expected < '1900'))('persists $expected through the public timed check command', async (item) => {
    const h = await createTestHarness();
    h.clock.zone = fixture.timeZoneId;
    try {
      const board = await createBoard(h.deps, {
        commandId: h.ids.nextCommandId(), title: 'Historical calendar', symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: false, tracksAmount: false, tracksTime: true, startOfDayMinute: 0, metricsEnabled: true,
      });
      if (!board.ok) throw new Error(board.error.message);
      const result = await createCheckIn(h.deps, {
        commandId: h.ids.nextCommandId(), boardId: board.value.boardId, occurredAtUtc: item.instant, source: 'app',
      });
      expect(result).toMatchObject({ ok: true, value: { logicalDate: item.expected, created: true } });
      expect(await h.db.getFirstAsync('SELECT logical_date, occurred_at_utc, time_zone_id, offset_minutes FROM check_ins WHERE board_id = ?', [board.value.boardId]))
        .toEqual({ logical_date: item.expected, occurred_at_utc: item.instant, time_zone_id: fixture.timeZoneId, offset_minutes: 0 });
    } finally { await h.db.closeAsync(); }
  });
});

describe('numeric wall-clock boundaries', () => {
  it('preserves the original Date rounding before applying a zone offset', () => {
    expect(localWallClock(-0.5, 'Etc/GMT-1'))
      .toEqual({ year: 1970, month: 1, day: 1, hour: 1, minute: 0 });
    expect(currentLogicalDate(-0.5, 'Etc/GMT-1', 60)).toBe('1970-01-01');
  });

  it.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001, -8_640_000_000_000_001])('rejects an invalid instant %s', (instant) => {
    expect(() => localWallClock(instant, 'UTC')).toThrow(RangeError);
  });

  it.each([
    [8_640_000_000_000_000, 'Etc/GMT-14'],
    [-8_640_000_000_000_000, 'Etc/GMT+12'],
  ] as const)('rejects a local wall instant outside the numeric Date range', (instant, zone) => {
    expect(() => localWallClock(instant, zone)).toThrow(RangeError);
  });

  it('retains exact historical seconds when the local date crosses midnight', () => {
    expect(localWallClock(Date.parse('1900-01-01T23:50:38.999Z'), 'Europe/Paris'))
      .toEqual({ year: 1900, month: 1, day: 1, hour: 23, minute: 59 });
    expect(localWallClock(Date.parse('1900-01-01T23:50:39Z'), 'Europe/Paris'))
      .toEqual({ year: 1900, month: 1, day: 2, hour: 0, minute: 0 });
  });
});
