import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { isValidLogicalDate } from '@/core/calendar/logical-date';
import { planMissAlertTrigger } from '@/core/domain/miss-alerts';
import type { MissAlertEffectContext, MissAlertRequest, MissAlertScheduleOutcome, MissAlertScheduler, PendingMissAlertRequest } from '@/core/domain/ports';
import { missNotificationContent, readMissContent } from './miss-content';
import { inSchedulingLane, PENDING_NOTIFICATION_LIMIT } from './scheduling-lane';

const failed = (): MissAlertScheduleOutcome => ({ kind: 'not_accepted', code: 'schedule_failed' });
const retired = { kind: 'retired' } as const;

async function inspection<Value>(operation: () => Promise<Value>): Promise<Value> {
  try { return await operation(); }
  catch { throw new Error('Notifications could not be checked. Try again.'); }
}

function calendarInput(value: Record<string, unknown>): Notifications.CalendarTriggerInput | null {
  const { year, month, day, hour, minute, second } = value;
  if (![year, month, day].every(item => typeof item === 'number' && Number.isInteger(item)) ||
    hour !== 9 || minute !== 0 || second !== 0 ||
    !isValidLogicalDate(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)) return null;
  if (Object.entries(value).some(([key, item]) => {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(key)) return false;
    if (key === 'calendar') return item != null && item !== 'iso8601' && item !== 'gregorian';
    return item != null && item !== false;
  })) return null;
  return { type: Notifications.SchedulableTriggerInputTypes.CALENDAR, year: year as number,
    month: month as number, day: day as number, hour: 9, minute: 0, second: 0, repeats: false };
}

function capturePending(value: Notifications.NotificationRequest) {
  const { identifier, content, trigger } = value;
  if (typeof identifier !== 'string') throw new Error('Invalid native request.');
  const captured = readMissContent(identifier, content);
  const raw = trigger as unknown as Record<string, unknown> | null;
  let date: number | null = null;
  let calendar: Notifications.CalendarTriggerInput | null = null;
  if (captured && raw?.type === 'date' && raw.repeats === false && typeof raw.value === 'number' && Number.isFinite(raw.value)) date = raw.value;
  if (captured && raw?.type === 'calendar' && raw.repeats === false && raw.dateComponents && typeof raw.dateComponents === 'object') {
    calendar = calendarInput({ ...raw.dateComponents });
  }
  return { identifier, content: captured, date, calendar };
}

async function pendingRequests(): Promise<PendingMissAlertRequest[]> {
  const acceptance = Platform.OS === 'ios' ? 'confirmed' : 'unconfirmed';
  return inspection(async () => {
    // capture all rows before the first trigger-resolution await.
    const values = (await Notifications.getAllScheduledNotificationsAsync()).map(capturePending);
    return Promise.all(values.map(async value => {
      const next = value.calendar ? await Notifications.getNextTriggerDateAsync(value.calendar) : value.date;
      return { identifier: value.identifier, content: value.content,
        nextFireAtUtcMs: typeof next === 'number' && Number.isFinite(next) ? next : null, acceptance };
    }));
  });
}

function capture(request: MissAlertRequest, context: MissAlertEffectContext) {
  const value = { identifier: request.identifier, boardId: request.boardId, secondMissedDate: request.secondMissedDate,
    title: request.title, body: request.body, timeZoneId: request.timeZoneId, trigger: { ...request.trigger } };
  if (!readMissContent(value.identifier, missNotificationContent(value))) throw new Error('Invalid miss request.');
  const clock = context.clock;
  return { request: value, context: { clock: { nowUtcMs: clock.nowUtcMs.bind(clock), timeZoneId: clock.timeZoneId.bind(clock) },
    isCurrent: context.isCurrent.bind(context), isForeground: context.isForeground.bind(context) }, ios: Platform.OS === 'ios' };
}

type ResolvedTrigger = { trigger: Notifications.NotificationTriggerInput; fireAt: number | null };

async function resolveTrigger(request: MissAlertRequest, context: MissAlertEffectContext, ios: boolean): Promise<ResolvedTrigger | MissAlertScheduleOutcome> {
  if (!context.isCurrent() || context.clock.timeZoneId() !== request.timeZoneId) return retired;
  const planned = planMissAlertTrigger({ nowUtcMs: context.clock.nowUtcMs(), timeZoneId: request.timeZoneId,
    foreground: context.isForeground() });
  let trigger: Notifications.NotificationTriggerInput = null;
  let fireAt: number | null = null;
  if (planned.kind === 'local09') {
    const [year, month, day] = planned.date.split('-').map(Number);
    const resolver: Notifications.SchedulableNotificationTriggerInput = ios
      ? { type: Notifications.SchedulableTriggerInputTypes.CALENDAR, year, month, day, hour: 9, minute: 0, second: 0, repeats: false }
      : { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: 9, minute: 0 };
    const next = await Notifications.getNextTriggerDateAsync(resolver);
    if (!context.isCurrent() || context.clock.timeZoneId() !== request.timeZoneId) return retired;
    const updated = planMissAlertTrigger({ nowUtcMs: context.clock.nowUtcMs(), timeZoneId: request.timeZoneId,
      foreground: context.isForeground() });
    if (updated.kind !== 'immediate') {
      if (updated.date !== planned.date || next === null || !Number.isFinite(next) || next <= context.clock.nowUtcMs()) return failed();
      trigger = ios ? resolver : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: next };
      fireAt = next;
    }
  }
  return { trigger, fireAt };
}

async function dispatch(request: MissAlertRequest, context: MissAlertEffectContext, ios: boolean,
  trigger: Notifications.NotificationTriggerInput): Promise<MissAlertScheduleOutcome> {
  if (!context.isCurrent() || context.clock.timeZoneId() !== request.timeZoneId) return retired;
  try {
    const identifier = await Notifications.scheduleNotificationAsync({ identifier: request.identifier,
      content: missNotificationContent(request), trigger });
    return { kind: identifier === request.identifier ? 'accepted' : 'unknown' };
  } catch (cause) {
    try {
      if (ios && cause !== null && typeof cause === 'object' && 'code' in cause &&
        cause.code === 'ERR_NOTIFICATIONS_FAILED_TO_SCHEDULE') return failed();
    } catch { /* a thrown error getter cannot prove native non-acceptance */ }
    return { kind: 'unknown' };
  }
}

async function presentedIdentifiers(): Promise<string[]> {
  return inspection(async () => (await Notifications.getPresentedNotificationsAsync()).map(value => {
    const identifier = value.request.identifier;
    if (typeof identifier !== 'string') throw new Error('Invalid native identifier.');
    return identifier;
  }));
}

export const missAlertScheduler: MissAlertScheduler = {
  authorization: () => inspection(async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.ios) return permission.ios.status === 2 ? 'granted' : permission.ios.status === 1 ? 'denied' : 'undetermined';
    return permission.granted ? 'granted' : permission.canAskAgain ? 'undetermined' : 'denied';
  }),
  pendingRequests,
  presentedIdentifiers,
  async schedule(request, context) {
    try {
      const owned = capture(request, context);
      return await inSchedulingLane(async () => {
        if (!owned.context.isCurrent()) return retired;
        const rows = await pendingRequests();
        if (!owned.context.isCurrent()) return retired;
        const existing = rows.find(row => row.identifier === owned.request.identifier);
        if (existing) return { kind: existing.content && owned.ios ? 'accepted' : 'unknown' };
        if (rows.length >= PENDING_NOTIFICATION_LIMIT) return { kind: 'not_accepted', code: 'capacity' };
        const resolved = await resolveTrigger(owned.request, owned.context, owned.ios);
        return 'trigger' in resolved ? dispatch(owned.request, owned.context, owned.ios, resolved.trigger) : resolved;
      });
    } catch { return failed(); }
  },
  async refreshPending(input, context) {
    try {
      const owned = capture(input.replacement, context);
      const { identifier, content, nextFireAtUtcMs } = input.observed;
      const observed = readMissContent(identifier, missNotificationContent(content));
      const retained = input.retainedAcceptance;
      if (!observed || observed.identifier !== owned.request.identifier || !Number.isFinite(nextFireAtUtcMs) ||
        !['confirmed', 'unresolved'].includes(retained)) return { kind: 'unchanged' };
      return await inSchedulingLane(async () => {
        const current = () => owned.context.isCurrent() && owned.context.clock.timeZoneId() === owned.request.timeZoneId;
        if (!current()) return retired;
        const presented = await presentedIdentifiers();
        if (!current()) return retired;
        if (presented.includes(identifier)) return { kind: 'unchanged' };
        let rows = await pendingRequests();
        if (!current()) return retired;
        const live = () => rows.find(row => row.identifier === identifier && row.content &&
          row.nextFireAtUtcMs !== null && row.nextFireAtUtcMs > owned.context.clock.nowUtcMs());
        if (!live()) return { kind: 'unchanged' };
        let resolved = await resolveTrigger(owned.request, owned.context, owned.ios);
        if (!('trigger' in resolved)) return resolved;
        if (!current()) return retired;
        if (resolved.trigger !== null) {
          rows = await pendingRequests();
          if (!current()) return retired;
          // the final native inspection can cross 09:00 after trigger resolution.
          const planned = planMissAlertTrigger({ nowUtcMs: owned.context.clock.nowUtcMs(),
            timeZoneId: owned.request.timeZoneId, foreground: owned.context.isForeground() });
          if (planned.kind === 'immediate') resolved = { trigger: null, fireAt: null };
          else if (resolved.fireAt === null || resolved.fireAt <= owned.context.clock.nowUtcMs()) return failed();
        }
        const existing = live();
        if (!existing) return { kind: 'unchanged' };
        if (resolved.fireAt === existing.nextFireAtUtcMs && (retained === 'confirmed' || owned.ios)) return { kind: 'unchanged' };
        if (!owned.ios && resolved.trigger === null) {
          try { await Notifications.cancelScheduledNotificationAsync(identifier); }
          catch { return { kind: 'unknown' }; }
          if (!current()) return { kind: 'cancelled' };
          rows = await pendingRequests();
          if (!current()) return { kind: 'cancelled' };
          if (rows.some(row => row.identifier === identifier)) return { kind: 'unknown' };
          if (rows.length >= PENDING_NOTIFICATION_LIMIT) return { kind: 'not_accepted', code: 'capacity' };
        }
        return dispatch(owned.request, owned.context, owned.ios, resolved.trigger);
      });
    } catch { return { kind: 'unknown' }; }
  },
  async cancel(identifier, context) {
    try {
      const isCurrent = context.isCurrent.bind(context);
      return await inSchedulingLane(async () => {
        if (!isCurrent()) return retired;
        try { await Notifications.cancelScheduledNotificationAsync(identifier); }
        catch { return { kind: 'unknown' }; }
        return { kind: 'cancelled' };
      });
    } catch { return { kind: 'unknown' }; }
  },
};
