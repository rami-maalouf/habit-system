import { localWallClock } from './logical-date';

const MINUTE_MS = 60_000;
const MAX_LOOKAHEAD_MS = 48 * 60 * MINUTE_MS;

// a conservative display refresh deadline, never a board's economic day close.
// local midnight also expires shifted rows early, before their actual day changes.
export function nextWidgetRefreshUtc(
  nowUtcMs: number,
  timeZoneId: string,
  startMinutes: readonly number[] = [],
): number {
  const initial = localWallClock(nowUtcMs, timeZoneId);
  const initialDate = `${initial.year}-${initial.month}-${initial.day}`;
  const initialMinute = initial.hour * 60 + initial.minute;
  const starts = [...new Set(startMinutes)];
  const limit = nowUtcMs + MAX_LOOKAHEAD_MS;
  for (let instant = Math.floor(nowUtcMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS; instant < limit; instant += MINUTE_MS) {
    const local = localWallClock(instant, timeZoneId);
    const minute = local.hour * 60 + local.minute;
    if (`${local.year}-${local.month}-${local.day}` !== initialDate ||
        starts.some((start) => (minute < start) !== (initialMinute < start))) return instant;
  }
  return limit;
}
