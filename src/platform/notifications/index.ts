import * as Notifications from 'expo-notifications';

import { inSchedulingLane, PENDING_NOTIFICATION_LIMIT } from './scheduling-lane';
import { isMissAlertIdentifierFamily } from '@/core/domain/miss-alerts';
import { readMissContent } from './miss-content';

import type {
  PendingReminderRequest,
  ReminderAuthorization,
  ReminderSchedulerFailure,
  ReminderSchedulerFailureCode,
  ReminderScheduler,
  ReminderScheduleRequest,
} from '@/core/domain/ports';

export { missAlertScheduler } from './miss-alerts';

const SCHEDULER_ERROR_MESSAGES: Record<ReminderSchedulerFailureCode, string> = {
  authorization_unavailable: 'Notification permission is temporarily unavailable.',
  pending_unavailable: 'Scheduled notifications could not be checked. Try again.',
  capacity_unavailable: 'Notification capacity could not be checked. Try again.',
  schedule_failed: 'The notification could not be scheduled. Try again.',
  cancel_failed: 'The notification could not be cancelled. Try again.',
};

export class ReminderSchedulerError extends Error implements ReminderSchedulerFailure {
  readonly name = 'ReminderSchedulerError' as const;

  constructor(readonly code: ReminderSchedulerFailureCode) {
    super(SCHEDULER_ERROR_MESSAGES[code]);
  }
}

async function schedulerOperation<Value>(
  code: ReminderSchedulerFailureCode,
  operation: () => Promise<Value>,
): Promise<Value> {
  try {
    return await operation();
  } catch {
    // never carry native error details across the platform boundary
    throw new ReminderSchedulerError(code);
  }
}

// ios caps the pending local-notification pool at 64 requests
const IOS_PENDING_LIMIT = PENDING_NOTIFICATION_LIMIT;

// without a handler expo suppresses notifications that fire while the app
// is foregrounded; reminders must still present as banners
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function toAuthorization(status: Notifications.NotificationPermissionsStatus): ReminderAuthorization {
  if (status.granted) {
    return 'granted';
  }
  return status.canAskAgain ? 'undetermined' : 'denied';
}

// expo weekly triggers number weekdays 1 (sunday) through 7 (saturday);
// the domain speaks iso 1 (monday) through 7 (sunday)
function toExpoWeekday(isoWeekday: number): number {
  return (isoWeekday % 7) + 1;
}

// ios serializes weekly requests as calendar triggers; android uses
// weekly triggers. read the native trigger, not data copied at save time.
function pendingReminderRequest(pending: Notifications.NotificationRequest): PendingReminderRequest {
  const { trigger, content, identifier } = pending;
  const unsupported = { identifier, request: null };
  if (!trigger) {
    return unsupported;
  }
  const nativeTrigger = trigger as unknown as Record<string, unknown>;
  const calendar = nativeTrigger.type === 'calendar' && nativeTrigger.repeats === true;
  const components = calendar ? nativeTrigger.dateComponents
    : nativeTrigger.type === 'weekly' ? nativeTrigger : null;
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    return unsupported;
  }
  // extra calendar constraints could turn a weekly request into a dated
  // or timezone-pinned schedule; the desired reminder follows local time.
  if (calendar && Object.entries(components).some(([key, value]) =>
    !['weekday', 'hour', 'minute'].includes(key) && value != null && value !== false,
  )) {
    return unsupported;
  }
  const { weekday, hour, minute } = components as Record<string, unknown>;
  const data = content.data;
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
    typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
    typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59 ||
    typeof data?.boardId !== 'string' || typeof data.reminderId !== 'string' ||
    typeof content.title !== 'string' || typeof content.body !== 'string') {
    return unsupported;
  }
  return {
    identifier,
    request: {
      reminderId: data.reminderId,
      boardId: data.boardId,
      weekday: ((weekday + 5) % 7) + 1,
      minuteOfDay: hour * 60 + minute,
      title: content.title,
      body: content.body,
    },
  };
}

export const reminderScheduler: ReminderScheduler = {
  async authorization(): Promise<ReminderAuthorization> {
    return schedulerOperation('authorization_unavailable', async () =>
      toAuthorization(await Notifications.getPermissionsAsync()),
    );
  },

  async requestAuthorization(): Promise<ReminderAuthorization> {
    return schedulerOperation('authorization_unavailable', async () =>
      toAuthorization(
        await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: true },
        }),
      ),
    );
  },

  async remainingCapacity(): Promise<number> {
    return schedulerOperation('capacity_unavailable', async () => {
      const pending = await Notifications.getAllScheduledNotificationsAsync();
      return IOS_PENDING_LIMIT - pending.length;
    });
  },

  async pendingIdentifiers(): Promise<string[]> {
    return schedulerOperation('pending_unavailable', async () => {
      const pending = await Notifications.getAllScheduledNotificationsAsync();
      return pending.map((request) => request.identifier);
    });
  },

  async pendingRequests(): Promise<PendingReminderRequest[]> {
    return schedulerOperation('pending_unavailable', async () =>
      (await Notifications.getAllScheduledNotificationsAsync()).map(pendingReminderRequest),
    );
  },

  async schedule(request: ReminderScheduleRequest): Promise<string> {
    const owned = { ...request };
    return schedulerOperation('schedule_failed', () => inSchedulingLane(async () => {
      if ((await Notifications.getAllScheduledNotificationsAsync()).length >= IOS_PENDING_LIMIT) {
        throw new ReminderSchedulerError('schedule_failed');
      }
      return Notifications.scheduleNotificationAsync({
        content: {
          title: owned.title,
          body: owned.body,
          sound: 'default',
          // the tap handler deep-links straight to the add check-in sheet
          data: { boardId: owned.boardId, reminderId: owned.reminderId },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
          weekday: toExpoWeekday(owned.weekday),
          hour: Math.floor(owned.minuteOfDay / 60),
          minute: owned.minuteOfDay % 60,
        },
      });
    }));
  },

  async cancel(identifiers: string[]): Promise<void> {
    const owned = [...identifiers];
    await schedulerOperation('cancel_failed', () => inSchedulingLane(() => Promise.all(
      owned.map((identifier) =>
        Notifications.cancelScheduledNotificationAsync(identifier),
      ),
    )));
  },
};

// a tapped reminder carries its board id; the router turns that into the
// board's add check-in sheet
export function boardIdFromNotificationResponse(
  response: Notifications.NotificationResponse,
): string | null {
  const data = response.notification.request.content.data as
    | Record<string, unknown>
    | null
    | undefined;
  return data && typeof data.boardId === 'string' ? data.boardId : null;
}

export type NotificationDestination = { kind: 'board' | 'new-check'; boardId: string };

export function notificationDestinationFromResponse(response: Notifications.NotificationResponse): NotificationDestination | null {
  const { identifier, content } = response.notification.request;
  if (isMissAlertIdentifierFamily(identifier)) {
    const miss = readMissContent(identifier, content);
    return miss ? { kind: 'board', boardId: miss.boardId } : null;
  }
  const boardId = boardIdFromNotificationResponse(response);
  return boardId ? { kind: 'new-check', boardId } : null;
}

export function addNotificationDestinationListener(handler: (destination: NotificationDestination) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(response => {
    const destination = notificationDestinationFromResponse(response);
    if (destination) handler(destination);
  });
  return () => subscription.remove();
}

export async function getInitialNotificationDestination(): Promise<NotificationDestination | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) return null;
  Notifications.clearLastNotificationResponse();
  return notificationDestinationFromResponse(response);
}

export function addNotificationDeliveryListener(handler: () => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener(handler);
  return () => subscription.remove();
}

// taps while the app runs (or is backgrounded) arrive through the listener
export function addNotificationTapListener(handler: (boardId: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const boardId = boardIdFromNotificationResponse(response);
    if (boardId) {
      handler(boardId);
    }
  });
  return () => subscription.remove();
}

// a tap that cold-started the app is delivered once on launch; consuming
// it clears the stored response so a provider remount cannot replay it
export async function getInitialNotificationBoardId(): Promise<string | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) {
    return null;
  }
  Notifications.clearLastNotificationResponse();
  return boardIdFromNotificationResponse(response);
}
