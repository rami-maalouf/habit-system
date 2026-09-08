import type { LogicalDate } from '../domain/ids';
import { isValidLogicalDate, parseLogicalDate } from './logical-date';
import { createOffsetSecondsReader } from './time-zone-offset';

const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;

function validate(date: LogicalDate, startMinute: number): void {
  if (typeof date !== 'string' || !isValidLogicalDate(date) ||
      !Number.isInteger(startMinute) || startMinute < 0 || startMinute > 720 || startMinute % 30 !== 0) {
    throw new RangeError('invalid economic day');
  }
}

// own one resolver per transaction; historical dates never accumulate globally.
export function createEconomicDayCloseResolver(timeZoneId: string): (date: LogicalDate, startMinute: number) => number {
  const offsetSecondsAt = createOffsetSecondsReader(timeZoneId);
  const results = new Map<string, number>();
  return (date, startMinute) => {
    validate(date, startMinute);
    const key = `${date}|${startMinute}`;
    const existing = results.get(key);
    if (existing !== undefined) return existing;
    const result = resolveEconomicDayClose(date, startMinute, offsetSecondsAt);
    results.set(key, result);
    return result;
  };
}

// the offset port returns exact seconds for a utc millisecond instant. supported
// iana data has at most one transition per hour; revisit that bound on tzdb updates.
export function resolveEconomicDayClose(
  date: LogicalDate,
  startMinute: number,
  offsetSecondsAt: (utcMs: number) => number,
): number {
  validate(date, startMinute);
  const { year, month, day } = parseLogicalDate(date);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day + 1);
  wall.setUTCHours(0, startMinute, 0, 0);
  const target = wall.getTime();
  const offsets = new Map<number, number>();
  const offset = (instant: number): number => {
    const cached = offsets.get(instant);
    if (cached !== undefined) return cached;
    const seconds = offsetSecondsAt(instant);
    if (!Number.isInteger(seconds) || Math.abs(seconds) >= 86400) throw new RangeError('unsupported time zone offset');
    offsets.set(instant, seconds * SECOND);
    return seconds * SECOND;
  };
  const verify = (candidate: number): number => {
    if (candidate + offset(candidate) < target || candidate - 1 + offset(candidate - 1) >= target) {
      throw new RangeError('inconsistent time zone boundary');
    }
    return candidate;
  };
  const crossing = (from: number, to: number, shift: number): number | null => {
    const candidate = Math.max(from, target - shift);
    return candidate >= to ? null : verify(candidate);
  };
  let left = target - DAY;
  let before = offset(left);
  // offsets strictly inside +/-24h guarantee a crossing in these 48 intervals.
  // after 47 intervals the final candidate must be inside interval 48.
  for (let index = 0; ; index += 1) {
    const right = left + HOUR;
    const after = offset(right);
    if (before !== after) {
      let low = left, high = right;
      while (high - low > SECOND) {
        const middle = Math.floor((low + high) / (2 * SECOND)) * SECOND;
        if (offset(middle) === before) low = middle;
        else high = middle;
      }
      const first = crossing(left, high, before);
      if (first !== null) return first;
      left = high;
    }
    if (index === 47) return verify(Math.max(left, target - after));
    const result = crossing(left, right, after);
    if (result !== null) return result;
    left = right;
    before = after;
  }
}
