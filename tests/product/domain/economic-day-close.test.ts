import { createEconomicDayCloseResolver, resolveEconomicDayClose } from '@/core/calendar/economic-day-close';
import vectors from '@/core/calendar/fixtures/economic-day-close.json';
import type { LogicalDate } from '@/core/domain/ids';

describe('economic day close', () => {
  it.each(vectors)('finds the first crossing for $date in $zone with shift $shift', (vector) => {
    const resolve = createEconomicDayCloseResolver(vector.zone);
    const close = resolve(vector.date as LogicalDate, vector.shift);
    expect(close).toBe(vector.expectedUtcMs);
    expect(vector.expectedUtcMs).toBe(Date.parse(vector.expected));
    expect(resolve(vector.date as LogicalDate, vector.shift)).toBe(close);
  });

  it('retains the earlier close when a repeated hour later moves the displayed day backward', () => {
    const resolve = createEconomicDayCloseResolver('America/New_York');
    expect(resolve('2026-10-31' as LogicalDate, 90)).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });

  it.each(['2026-02-30', '26-01-01', '10000-01-01', '', null, ['2026-09-08']])('rejects invalid dates before resolving: %s', (value) => {
    expect(() => createEconomicDayCloseResolver('UTC')(value as LogicalDate, 0)).toThrow();
  });

  it.each([-30, 15, 721, 30.5, NaN, Infinity, '30', null])('rejects invalid board shifts: %s', (value) => {
    expect(() => createEconomicDayCloseResolver('UTC')('2026-09-08' as LogicalDate, value as number)).toThrow();
  });

  it.each(['Invalid/Zone', '+23:59', '', null, ['UTC']])('rejects unsupported zone identifiers: %s', (zone) => {
    expect(() => createEconomicDayCloseResolver(zone as string)).toThrow();
  });

  it('reads complete Hermes formatted offsets including historical seconds', () => {
    // captured hermes parts split gmt, sign, hours and minutes into separate parts.
    const format = jest.fn().mockReturnValue('1/1/1900, GMT+00:09:21');
    const formatter = jest.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ format } as unknown as Intl.DateTimeFormat);
    try {
      const resolve = createEconomicDayCloseResolver('Europe/Paris');
      const close = resolve('1900-01-01' as LogicalDate, 0);
      expect(close).toBe(Date.parse('1900-01-01T23:50:39Z'));
      format.mockImplementation(() => { throw new Error('the transaction reuses its captured result'); });
      expect(resolve('1900-01-01' as LogicalDate, 0)).toBe(close);
    } finally { formatter.mockRestore(); }
  });

  it.each([
    ['9/8/2026, GMT-04:00', '2026-09-09T04:00:00Z'],
    ['9/9/2026, GMT+00:00', '2026-09-09T00:00:00Z'],
  ])('reads the captured Hermes suffix %s', (formatted, expected) => {
    const formatter = jest.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ format: () => formatted } as unknown as Intl.DateTimeFormat);
    try { expect(createEconomicDayCloseResolver('UTC')('2026-09-08' as LogicalDate, 0)).toBe(Date.parse(expected)); }
    finally { formatter.mockRestore(); }
  });

  it('keeps zero and negative close values in its transaction cache', () => {
    const format = jest.fn().mockReturnValue('1/1/1970, GMT');
    const formatter = jest.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ format } as unknown as Intl.DateTimeFormat);
    try {
      const resolve = createEconomicDayCloseResolver('UTC');
      expect(resolve('1969-12-31' as LogicalDate, 0)).toBe(0);
      expect(resolve('1969-12-30' as LogicalDate, 0)).toBe(-86_400_000);
      format.mockImplementation(() => { throw new Error('cached result must not consult the runtime'); });
      expect(resolve('1969-12-31' as LogicalDate, 0)).toBe(0);
      expect(resolve('1969-12-30' as LogicalDate, 0)).toBe(-86_400_000);
      expect(() => resolve(['1969-12-31'] as unknown as LogicalDate, 0)).toThrow();
    } finally { formatter.mockRestore(); }
  });

  it.each(['9/8/2026, UTC', '9/8/2026, GMT+24:00', '9/8/2026, GMT+00:60', '9/8/2026, GMT+00:00:60', '9/8/2026, GMT-04:00 extra'])('rejects malformed runtime offset output: %s', (formatted) => {
    const formatter = jest.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ format: () => formatted } as unknown as Intl.DateTimeFormat);
    try { expect(() => createEconomicDayCloseResolver('UTC')('2026-09-08' as LogicalDate, 0)).toThrow(); }
    finally { formatter.mockRestore(); }
  });

  it('resolves synthetic second-aligned gaps and folds in chronological order', () => {
    const date = '2026-09-08' as LogicalDate;
    const target = Date.parse('2026-09-09T00:00:00Z');
    const transition = target - 30_000;
    expect(resolveEconomicDayClose(date, 0, (instant) => instant < transition ? 0 : 90)).toBe(transition);
    expect(resolveEconomicDayClose(date, 0, (instant) => instant < transition ? 90 : 0)).toBe(target - 90_000);
  });

  it.each([-86_400, 86_400, 0.5, NaN, Infinity])('rejects unsupported offsets without a fabricated close: %s', (offset) => {
    expect(() => resolveEconomicDayClose('2026-09-08' as LogicalDate, 0, () => offset)).toThrow();
  });

  it('resolves offsets near both allowed extremes within the bounded search', () => {
    const date = '2026-09-08' as LogicalDate;
    const target = Date.parse('2026-09-09T00:00:00Z');
    expect(resolveEconomicDayClose(date, 0, () => -86399)).toBe(target + 86_399_000);
    expect(resolveEconomicDayClose(date, 0, () => 86399)).toBe(target - 86_399_000);
  });

  it.each(['candidate', 'predecessor'])('rejects inconsistent runtime offset evidence at the %s', (changed) => {
    const target = Date.parse('2026-09-09T00:00:00Z');
    const candidate = target - 90_000;
    const offset = (instant: number) => {
      if (changed === 'candidate' && instant === candidate) return 89;
      if (changed === 'predecessor' && instant === candidate - 1) return 91;
      return 90;
    };
    expect(() => resolveEconomicDayClose('2026-09-08' as LogicalDate, 0, offset)).toThrow('inconsistent time zone boundary');
  });
});
