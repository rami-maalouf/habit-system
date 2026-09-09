import type { BoardId, LogicalDate } from './ids';

export interface Clock {
  nowUtcMs(): number;
  timeZoneId(): string;
}

export interface IdGenerator {
  uuid(): string;
}

export interface Hashing {
  sha1(bytes: Uint8Array): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<Uint8Array>;
}

export type ReminderAuthorization = 'granted' | 'denied' | 'undetermined';

export type ReminderScheduleRequest = {
  reminderId: string;
  boardId: string;
  // iso weekday, 1 (monday) through 7 (sunday); the adapter converts to
  // the platform's own weekday numbering
  weekday: number;
  minuteOfDay: number;
  title: string;
  body: string;
};

export type PendingReminderRequest = {
  identifier: string;
  // null preserves orphan visibility when native content is malformed or
  // the trigger does not describe a repeating weekly reminder
  request: ReminderScheduleRequest | null;
};

export type ReminderSchedulerFailureCode =
  | 'authorization_unavailable'
  | 'pending_unavailable'
  | 'capacity_unavailable'
  | 'schedule_failed'
  | 'cancel_failed';

export interface ReminderSchedulerFailure extends Error {
  readonly name: 'ReminderSchedulerError';
  readonly code: ReminderSchedulerFailureCode;
}

// the platform notification adapter: repeating weekly local notifications
// at a wall-clock time, plus authorization and remaining native capacity
export interface ReminderScheduler {
  authorization(): Promise<ReminderAuthorization>;
  requestAuthorization(): Promise<ReminderAuthorization>;
  remainingCapacity(): Promise<number>;
  // identifiers of every pending native request, so the reconciler can
  // detect untracked orphans and duplicates after a crash
  pendingIdentifiers(): Promise<string[]>;
  pendingRequests(): Promise<PendingReminderRequest[]>;
  schedule(request: ReminderScheduleRequest): Promise<string>;
  cancel(identifiers: string[]): Promise<void>;
}

export type MissAlertPair = Readonly<{
  boardId: BoardId;
  secondMissedDate: LogicalDate;
}>;

export type MissAlertTrigger =
  | Readonly<{ kind: 'local09'; date: LogicalDate }>
  | Readonly<{ kind: 'immediate' }>;

export type MissAlertContent = MissAlertPair & Readonly<{
  identifier: string;
  title: string;
  body: string;
}>;

export type MissAlertRequest = MissAlertContent & Readonly<{
  trigger: MissAlertTrigger;
  // the zone in which the acquired plan was made; never part of pair identity.
  timeZoneId: string;
}>;

export type PendingMissAlertRequest = Readonly<{
  // includes every native request, even malformed miss content and ordinary reminders.
  identifier: string;
  // validates captured title/body/pair self-consistency, not equality to today's title.
  content: MissAlertContent | null;
  // derived from the actual native trigger, never copied firing metadata in content.
  // null means no usable future occurrence, not proof of delivery or cancellation.
  nextFireAtUtcMs: number | null;
  // ios pending inventory can confirm acceptance; android's saved store cannot.
  acceptance: 'confirmed' | 'unconfirmed';
}>;

export type FuturePendingMissAlertRequest = Readonly<{
  identifier: string;
  content: MissAlertContent;
  nextFireAtUtcMs: number;
  acceptance: 'confirmed' | 'unconfirmed';
}>;

export type MissAlertEffectContext = Readonly<{
  clock: Clock;
  isForeground(): boolean;
  // synchronous validity of the acquired qualification/generation, including its zone
  // and logical-date boundary. no sql or async callback inside the native lane.
  isCurrent(): boolean;
}>;

export type MissAlertScheduleOutcome =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'not_accepted'; code: 'capacity' | 'schedule_failed' }>
  | Readonly<{ kind: 'unknown' }>
  // no native effect was dispatched by this operation.
  | Readonly<{ kind: 'retired' }>;

export type MissAlertRefreshOutcome = MissAlertScheduleOutcome
  // no replacement needed or no longer a positively observed future pending request.
  | Readonly<{ kind: 'unchanged' }>
  // old future request was cancelled, but retirement prevented the immediate replacement.
  // this is a factual cancellation result, never a fresh-attempt permission.
  | Readonly<{ kind: 'cancelled' }>;

export type MissAlertCancelOutcome =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'retired' }>;

export interface MissAlertScheduler {
  // no request-authorization operation exists on this port.
  authorization(): Promise<ReminderAuthorization>;
  pendingRequests(): Promise<PendingMissAlertRequest[]>;
  presentedIdentifiers(): Promise<string[]>;
  // checks its existing shared capacity policy inside the same live scheduling lane.
  // snapshots arguments/method receivers before its first await, then checks isCurrent
  // after each await and immediately before dispatch. after dispatch, always return the
  // factual accepted/unknown result, even if the provider retired in the meantime.
  schedule(request: MissAlertRequest, context: MissAlertEffectContext): Promise<MissAlertScheduleOutcome>;
  refreshPending(input: Readonly<{
    observed: FuturePendingMissAlertRequest;
    replacement: MissAlertRequest;
    // captured from the consumed row, separate from native inventory evidence.
    // confirmed is scheduled/id; unresolved is pending/id or error/id.
    retainedAcceptance: 'confirmed' | 'unresolved';
  }>, context: MissAlertEffectContext): Promise<MissAlertRefreshOutcome>;
  // a single id makes partial cancellation and retirement outcomes unambiguous.
  cancel(identifier: string, context: MissAlertEffectContext): Promise<MissAlertCancelOutcome>;
}

// read failures reject with safe platform errors. schedule/refresh/cancel catch native
// failures into the outcomes above; an unexpected rejection is handled conservatively
// by core because a native effect might already have started. no native error text is ui.
// refresh requires a retained non-null identical id and matching pair, then re-inspects
// the native request under the lane. no caller-supplied observation is itself authority.
// only a positive future request can be updated; absent/past/presented cannot be reissued.
// on android, unresolved + unchanged future date still needs a same-id re-arm to confirm.
// null/immediate requires confirmed cancellation of the old dated request first.
// every refresh outcome retains the consumed row id, including not_accepted/retired.
