import { addDays, currentLogicalDate, isValidLogicalDate } from '../calendar/logical-date';
import { nextWidgetRefreshUtc } from '../calendar/widget-refresh';
import type { SqlDatabase, SqlExecutor } from '../persistence/database';
import { readEffectiveMissAlertDates, readMissAlertBoards, readMissAlertPeriods, readMissAlertRows,
  readUnresolvedMissAlertRows, replaceMissAlertRow, type MissAlertRow } from '../persistence/repositories/miss-alerts';
import type { BoardId, LogicalDate } from './ids';
import { createMissAlertRequest, futurePendingMissAlert, isMissAlertIdentifierFamily, isMissAlertPairValid,
  missAlertIdentifier, parseMissAlertIdentifier, planMissAlertPair, type MissAlertBoardEvidence,
  type MissAlertTime } from './miss-alerts';
import type { Clock, MissAlertCancelOutcome, MissAlertEffectContext, MissAlertPair, MissAlertRefreshOutcome,
  MissAlertScheduleOutcome, MissAlertScheduler } from './ports';
import { err, ok, type DomainError, type DomainResult } from './result';

export type MissAlertDeps = Readonly<{ db: SqlDatabase; clock: Clock; scheduler: MissAlertScheduler }>;
export type MissAlertReconcileInput = Readonly<{ isForeground(): boolean; isCurrent(): boolean }>;
export type MissAlertReconcileResult = Readonly<{
  localChanged: boolean; refreshPendingCount: boolean; nextRunAtUtcMs: number | null; error: DomainError | null;
}>;
const key = missAlertIdentifier;
const failure = (code: 'database' | 'platform' | 'capacity', retryable = true): DomainError => ({ code,
  message: 'Miss alerts could not be updated. Try again.', retryable });

async function readEvidence(tx: SqlExecutor, time: MissAlertTime, pairs: readonly MissAlertPair[], includeActive: boolean) {
  const boards = await readMissAlertBoards(tx, pairs.map(pair => pair.boardId), includeActive);
  const periods = new Map((await readMissAlertPeriods(tx, boards.map(board => board.id))).map(row => [row.boardId, row.periods]));
  const wanted = new Map(pairs.map(pair => [key(pair), pair]));
  if (includeActive) for (const board of boards) {
    const date = addDays(currentLogicalDate(time.nowUtcMs, time.timeZoneId, board.startOfDayMinute), -1);
    if (isValidLogicalDate(date)) wanted.set(key({ boardId: board.id, secondMissedDate: date }), { boardId: board.id, secondMissedDate: date });
  }
  const dates = [...wanted.values()].flatMap(pair => [addDays(pair.secondMissedDate, -1), pair.secondMissedDate]
    .filter(isValidLogicalDate).map(logicalDate => ({ boardId: pair.boardId, logicalDate })));
  const checked = new Map<BoardId, LogicalDate[]>();
  for (const row of await readEffectiveMissAlertDates(tx, dates)) {
    const list = checked.get(row.boardId) ?? []; list.push(row.logicalDate); checked.set(row.boardId, list);
  }
  return new Map<BoardId, MissAlertBoardEvidence>(boards.map(board => [board.id, { board, periods: periods.get(board.id)!,
    effectiveCheckedDates: checked.get(board.id) ?? [] }]));
}

export async function reconcileMissAlerts(deps: MissAlertDeps, input: MissAlertReconcileInput): Promise<MissAlertReconcileResult> {
  const result = { localChanged: false, refreshPendingCount: false, nextRunAtUtcMs: null as number | null, error: null as DomainError | null };
  let boundary: 'platform' | 'database' = 'platform';
  let capturedClock: Clock | null = null;
  try {
    const db = deps.db;
    const clock = { nowUtcMs: deps.clock.nowUtcMs.bind(deps.clock), timeZoneId: deps.clock.timeZoneId.bind(deps.clock) };
    capturedClock = clock;
    const isCurrent = input.isCurrent.bind(input); const isForeground = input.isForeground.bind(input);
    const scheduler: MissAlertScheduler = {
      authorization: deps.scheduler.authorization.bind(deps.scheduler), pendingRequests: deps.scheduler.pendingRequests.bind(deps.scheduler),
      presentedIdentifiers: deps.scheduler.presentedIdentifiers.bind(deps.scheduler), schedule: deps.scheduler.schedule.bind(deps.scheduler),
      refreshPending: deps.scheduler.refreshPending.bind(deps.scheduler), cancel: deps.scheduler.cancel.bind(deps.scheduler),
    };
    const now = (): MissAlertTime => ({ nowUtcMs: clock.nowUtcMs(), timeZoneId: clock.timeZoneId(), foreground: isForeground() });
    const wake = (utcMs: number) => {
      if (utcMs > clock.nowUtcMs() && (result.nextRunAtUtcMs === null || utcMs < result.nextRunAtUtcMs)) result.nextRunAtUtcMs = utcMs;
    };
    const report = (code: 'platform' | 'capacity', retryable: boolean) => {
      result.error = failure(code, retryable);
      if (retryable) wake(clock.nowUtcMs() + 30_000);
    };
    const context = (time: MissAlertTime, evidence: MissAlertBoardEvidence | null): MissAlertEffectContext => ({ clock, isForeground,
      isCurrent: () => isCurrent() && clock.timeZoneId() === time.timeZoneId && (!evidence ||
        currentLogicalDate(clock.nowUtcMs(), time.timeZoneId, evidence.board.startOfDayMinute) ===
        currentLogicalDate(time.nowUtcMs, time.timeZoneId, evidence.board.startOfDayMinute)) });
    const write = async (prior: MissAlertRow, next: MissAlertRow) => {
      boundary = 'database';
      result.localChanged = await db.withExclusiveTransactionAsync(tx => replaceMissAlertRow(tx, prior, next)) || result.localChanged;
    };
    const inspect = async (pair: MissAlertPair) => {
      boundary = 'database';
      return db.withTransactionAsync(async tx => {
        const time = now();
        const evidence = (await readEvidence(tx, time, [pair], false)).get(pair.boardId) ?? null;
        const row = (await readMissAlertRows(tx, [pair]))[0] ?? null;
        return { time, evidence, row, valid: isMissAlertPairValid(pair, evidence, time) };
      });
    };
    const cancel = async (identifier: string, effectContext: MissAlertEffectContext) => {
      if (!effectContext.isCurrent()) return false;
      boundary = 'platform';
      let outcome: MissAlertCancelOutcome;
      try { outcome = await scheduler.cancel(identifier, effectContext); } catch { outcome = { kind: 'unknown' }; }
      if (outcome.kind !== 'retired') result.refreshPendingCount = true;
      if (outcome.kind === 'unknown') report('platform', true);
      return outcome.kind === 'cancelled';
    };
    const settle = async (reserved: MissAlertRow, outcome: MissAlertRefreshOutcome, fresh: boolean, prior: MissAlertRow | null) => {
      if (outcome.kind === 'retired') {
        if (fresh) await write(reserved, prior ?? { ...reserved, status: 'pending', nativeIdentifier: null });
        return;
      }
      if (outcome.kind === 'unchanged') return;
      result.refreshPendingCount = true;
      if (outcome.kind === 'cancelled') return;
      const next: MissAlertRow = outcome.kind === 'accepted'
        ? { ...reserved, status: 'scheduled', nativeIdentifier: key(reserved) }
        : { ...reserved, status: 'error', nativeIdentifier: fresh && outcome.kind === 'not_accepted' ? null : key(reserved) };
      await write(reserved, next);
      if (outcome.kind === 'unknown') report('platform', false);
      if (outcome.kind === 'not_accepted') report(outcome.code === 'capacity' ? 'capacity' : 'platform', fresh);
    };
    const recheckAfterEffect = async (pair: MissAlertPair) => {
      if (!isCurrent()) return;
      const state = await inspect(pair);
      if (!state.valid) await cancel(key(pair), context(state.time, state.evidence));
    };
    if (!isCurrent()) return result;
    const permission = await scheduler.authorization();
    const pending = (await scheduler.pendingRequests()).map(row => ({ ...row, content: row.content ? { ...row.content } : null }));
    const pendingPairs = pending.flatMap(row => { const pair = parseMissAlertIdentifier(row.identifier); return pair ? [pair] : []; });
    boundary = 'database';
    const initial = await db.withTransactionAsync(async tx => {
      const time = now();
      const unresolved = await readUnresolvedMissAlertRows(tx);
      const evidence = await readEvidence(tx, time, [...pendingPairs, ...unresolved], true);
      return { time, unresolved, evidence };
    });
    if (initial.evidence.size > 0) wake(nextWidgetRefreshUtc(initial.time.nowUtcMs, initial.time.timeZoneId,
      [...initial.evidence.values()].map(item => item.board.startOfDayMinute)));
    const blocked = new Set<string>();
    for (const observed of new Map(pending.map(row => [row.identifier, row])).values()) {
      if (!isCurrent()) break;
      if (!isMissAlertIdentifierFamily(observed.identifier)) continue;
      const pair = parseMissAlertIdentifier(observed.identifier);
      const state = pair ? await inspect(pair) : null;
      const time = state?.time ?? now();
      // content validation is independent of whether the native trigger is still future.
      const content = futurePendingMissAlert({ ...observed, nextFireAtUtcMs: time.nowUtcMs + 1 }, time.nowUtcMs);
      if (!pair || !state?.valid || state.row?.nativeIdentifier !== observed.identifier || !content) {
        blocked.add(observed.identifier);
        const cleaned = await cancel(observed.identifier, context(time, state?.evidence ?? null));
        if (cleaned && state?.valid && state.row?.nativeIdentifier !== observed.identifier) wake(clock.nowUtcMs() + 30_000);
        continue;
      }
      let row = state.row;
      if (row.status !== 'scheduled' && observed.acceptance === 'confirmed') {
        const recovered: MissAlertRow = { ...pair, status: 'scheduled', nativeIdentifier: observed.identifier };
        await write(row, recovered);
        row = recovered;
      }
      const future = futurePendingMissAlert(observed, time.nowUtcMs);
      if (!future) continue;
      wake(future.nextFireAtUtcMs);
      boundary = 'platform';
      const request = createMissAlertRequest({ ...pair, firstMissedDate: addDays(pair.secondMissedDate, -1), title: state.evidence!.board.title }, time);
      let outcome: MissAlertRefreshOutcome;
      try {
        outcome = await scheduler.refreshPending({ observed: future, replacement: request,
          retainedAcceptance: row.status === 'scheduled' ? 'confirmed' : 'unresolved' }, context(time, state.evidence));
      } catch { outcome = { kind: 'unknown' }; }
      await settle(row, outcome, false, row);
      if (outcome.kind !== 'retired' && outcome.kind !== 'unchanged') await recheckAfterEffect(pair);
    }
    if (isCurrent() && initial.unresolved.length > 0) {
      boundary = 'platform';
      const presented = new Set(await scheduler.presentedIdentifiers());
      for (const prior of initial.unresolved) if (presented.has(key(prior))) {
        await write(prior, { ...prior, status: 'scheduled', nativeIdentifier: key(prior) });
      }
    }
    for (const item of initial.evidence.values()) {
      if (!isCurrent()) break;
      const candidate = planMissAlertPair(item, initial.time);
      if (!candidate || blocked.has(key(candidate))) continue;
      boundary = 'database';
      const reserved = await db.withExclusiveTransactionAsync(async tx => {
        const time = now();
        if (!isCurrent()) return null;
        const evidence = (await readEvidence(tx, time, [candidate], false)).get(candidate.boardId);
        if (!evidence) return null;
        const current = planMissAlertPair(evidence, time);
        if (!current || key(current) !== key(candidate)) return null;
        const prior = (await readMissAlertRows(tx, [candidate]))[0] ?? null;
        if (prior && (prior.nativeIdentifier !== null || prior.status === 'denied')) return null;
        const pair = { boardId: current.boardId, secondMissedDate: current.secondMissedDate };
        const next: MissAlertRow = permission === 'denied' ? { ...pair, status: 'denied', nativeIdentifier: null }
          : { ...pair, status: 'pending', nativeIdentifier: permission === 'granted' ? key(current) : null };
        const request = permission === 'granted' ? createMissAlertRequest(current, time) : null;
        const changed = await replaceMissAlertRow(tx, prior, next);
        return { prior, next, changed, request, time, evidence };
      });
      if (!reserved) continue;
      result.localChanged ||= reserved.changed;
      if (!reserved.changed || permission !== 'granted') continue;
      boundary = 'platform';
      const effectContext = context(reserved.time, reserved.evidence);
      let outcome: MissAlertScheduleOutcome = { kind: 'retired' };
      if (effectContext.isCurrent()) {
        try { outcome = await scheduler.schedule(reserved.request!, effectContext); }
        catch { outcome = { kind: 'unknown' }; }
      }
      await settle(reserved.next, outcome, true, reserved.prior);
      if (outcome.kind !== 'retired' && outcome.kind !== 'not_accepted') await recheckAfterEffect(candidate);
    }
    if (isCurrent() && result.refreshPendingCount) {
      boundary = 'platform';
      for (const pending of await scheduler.pendingRequests()) {
        if (parseMissAlertIdentifier(pending.identifier) && pending.nextFireAtUtcMs !== null) wake(pending.nextFireAtUtcMs);
      }
    }
  } catch {
    result.error = failure(boundary);
  }
  if (capturedClock) {
    try {
      const now = capturedClock.nowUtcMs();
      if (!Number.isFinite(now)) throw new Error('invalid clock');
      if (result.nextRunAtUtcMs !== null && result.nextRunAtUtcMs <= now) result.nextRunAtUtcMs = null;
      if (result.error?.retryable) {
        const retry = now + 30_000;
        result.nextRunAtUtcMs = Math.min(result.nextRunAtUtcMs ?? retry, retry);
      }
    } catch {
      result.nextRunAtUtcMs = null;
      result.error = failure(boundary);
    }
  }
  return result;
}

export async function getPendingMissAlertCount(deps: Readonly<{
  db: SqlDatabase; scheduler: Pick<MissAlertScheduler, 'pendingRequests'>;
}>): Promise<DomainResult<number>> {
  let boundary: 'platform' | 'database' = 'platform';
  try {
    const db = deps.db;
    const pending = await deps.scheduler.pendingRequests();
    const pairs = new Map<string, MissAlertPair>();
    for (const { identifier } of pending) {
      const pair = parseMissAlertIdentifier(identifier);
      if (pair) pairs.set(identifier, pair);
    }
    boundary = 'database';
    const rows = await db.withTransactionAsync(tx => readMissAlertRows(tx, [...pairs.values()]));
    return ok(rows.filter(row => row.nativeIdentifier !== null && pairs.has(row.nativeIdentifier)).length);
  } catch {
    return err(boundary, 'Pending miss alerts could not be checked. Try again.', { retryable: true });
  }
}
