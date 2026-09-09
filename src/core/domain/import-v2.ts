import type { ImportBoardV2Draft, OwnV2ImportDraft } from '../export/import-parsers';
import { readOwnV2Evidence } from '../export/import-parsers';
import { admitRemoteFacts } from '../persistence/remote-fact-admission';
import { rebuildWidgetRows } from '../persistence/projections/widget-rows';
import { insertBoard, listUndeletedBoards } from '../persistence/repositories/boards';
import { insertCheckIn } from '../persistence/repositories/check-ins';
import { refreshCheckVisibility } from '../persistence/repositories/check-visibility';
import { insertReminder } from '../persistence/repositories/reminders';
import { insertReward } from '../persistence/repositories/rewards';
import { appendOutbox, insertPeriod, saveAnchorPresetMinutes, saveMetricsEducationDismissed } from '../persistence/repositories/support';
import type { SqlExecutor } from '../persistence/database';
import type { CommandContext, CommandDeps } from './command-context';
import type { ImportSummary } from './commands';
import type { Board } from './entities';
import type { BoardId, CheckInId, CommandId, LogicalDate, ReminderId, RewardId } from './ids';
import { RemoteFactAdmissionError } from './remote-fact-validation';
import { RemoteFactHashingError } from './remote-fact-hashing';
import { err, ok, type DomainResult } from './result';

// only this outer command mapper handles operation failures, after rollback.
export function mapImportFailure(cause: unknown): DomainResult<never> {
  if (cause instanceof RemoteFactHashingError) {
    return err('platform', 'The import could not be verified. Try again.', { retryable: true });
  }
  if (cause instanceof RemoteFactAdmissionError) {
    if (cause.reason === 'envelope') return err('validation', 'This import contains unreadable data.');
    if (cause.reason === 'capacity') return err('capacity', 'The import exceeds the available evidence capacity.', { retryable: true });
  }
  return err('database', 'The import could not be completed. Try again.', { retryable: true });
}

async function rawIds(tx: SqlExecutor, table: 'boards' | 'check_ins' | 'reminders' | 'rewards', incoming: readonly { sourceId: string }[]) {
  const ids = [...new Set(incoming.map(row => row.sourceId))];
  return new Set((await tx.getAllAsync<{ id: string }>(`SELECT id FROM ${table}
    WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)])).map(row => row.id));
}

function addSkipped(previous: number, added: number): number {
  const total = previous + added;
  if (!Number.isSafeInteger(total)) throw new RemoteFactAdmissionError('capacity');
  return total;
}

// a single acquired graph includes existing live and archived parents. an invalid
// new chain is skipped as a whole; no imported edge rewrites an existing row.
function restorableBoards(drafts: readonly ImportBoardV2Draft[], existing: readonly Board[], ownedIds: Set<string>) {
  const proposed = new Map<string, ImportBoardV2Draft>();
  for (const board of drafts) {
    if (!ownedIds.has(board.sourceId) && !proposed.has(board.sourceId)) proposed.set(board.sourceId, board);
  }
  const parents = new Map<string, string | null>(existing.map(board => [board.id, board.anchorBoardId]));
  for (const board of proposed.values()) parents.set(board.sourceId, board.anchorBoardId);
  const valid = new Map<string, boolean>();
  for (const id of proposed.keys()) {
    const path = new Set<string>(); let current: string | null = id; let admissible = true;
    while (current !== null) {
      if (valid.has(current)) { admissible = valid.get(current)!; break; }
      if (path.has(current) || !parents.has(current)) { admissible = false; break; }
      path.add(current); current = parents.get(current)!;
    }
    for (const step of path) valid.set(step, admissible);
  }
  return [...proposed.values()].filter(board => valid.get(board.sourceId));
}

async function restoreSettings(context: CommandContext, draft: OwnV2ImportDraft): Promise<NonNullable<ImportSummary['v2']>['settings']> {
  if (draft.settings.kind !== 'valid') return 'invalid';
  const { tx, settings, now } = context;
  const fresh = await tx.getFirstAsync<{ eligible: number }>(`SELECT
    settings_mutation_stamp IS NULL AND wake_minute = 420 AND lunch_minute = 720
    AND dinner_minute = 1080 AND sleep_minute = 1380 AND metrics_education_dismissed = '[]'
    AND NOT EXISTS (SELECT 1 FROM boards) AND NOT EXISTS (SELECT 1 FROM rewards)
    AND NOT EXISTS (SELECT 1 FROM habit_actions) AND NOT EXISTS (SELECT 1 FROM coin_ledger)
    AND NOT EXISTS (SELECT 1 FROM sync_deferred) AND NOT EXISTS (SELECT 1 FROM remote_fact_inbox)
    AS eligible FROM app_settings WHERE id = 1`);
  if (fresh?.eligible !== 1) return 'preserved';
  const value = draft.settings.value;
  if (value.wakeMinute === settings.wakeMinute && value.lunchMinute === settings.lunchMinute &&
    value.dinnerMinute === settings.dinnerMinute && value.sleepMinute === settings.sleepMinute &&
    value.metricsEducationDismissed.length === 0) return 'unchanged';
  const stamp = context.stamp();
  await saveAnchorPresetMinutes(tx, value, stamp);
  await saveMetricsEducationDismissed(tx, value.metricsEducationDismissed as BoardId[], stamp);
  await appendOutbox(tx, 'settings', 'app-settings', stamp, now);
  return 'restored';
}

// the public entry captures and validates scalar fields before awaiting the
// transaction. this layer decides identity, graph and settings against acquired state.
export async function importOwnV2(deps: CommandDeps, context: CommandContext, draft: OwnV2ImportDraft): Promise<DomainResult<ImportSummary>> {
  // capture already validated this exact owned string; this internal reparse
  // cannot lose envelope validity while the import waits for its transaction.
  const evidence = readOwnV2Evidence(draft.evidence.sourceJson) as Extract<ReturnType<typeof readOwnV2Evidence>, { ok: true }>;
  const { tx, now, timeZoneId, stamp } = context;
  const existing = await listUndeletedBoards(tx);
  const boardIds = await rawIds(tx, 'boards', draft.boards);
  const checkIds = await rawIds(tx, 'check_ins', draft.checkIns);
  const reminderIds = await rawIds(tx, 'reminders', draft.reminders);
  const rewardIds = await rawIds(tx, 'rewards', draft.rewards);
  const boards = restorableBoards(draft.boards, existing, boardIds);
  const parentIds = new Set<string>([...existing.map(board => board.id), ...boards.map(board => board.sourceId)]);
  const summary: ImportSummary & { v2: NonNullable<ImportSummary['v2']> } = {
    boardsCreated: 0, boardsSkipped: addSkipped(draft.skipped.boards, draft.boards.length - boards.length),
    checkInsCreated: 0, checkInsSkipped: draft.skipped.checkIns,
    remindersCreated: 0, remindersSkipped: draft.skipped.reminders,
    v2: { rewardsCreated: 0, rewardsSkipped: draft.skipped.rewards, settings: await restoreSettings(context, draft),
      immutable: { admitted: 0, generated: 0, duplicates: 0, pending: 0, blocked: 0, quarantined: 0 } },
  };
  // create all identities before applying forward references; the final raw
  // links are already validated and use the same local row stamp.
  for (const board of boards) {
    const mutationStamp = stamp();
    await insertBoard(tx, { ...board, id: board.sourceId as BoardId, anchorBoardId: null,
      archivedAt: board.archivedAtUtc, createdAt: board.createdAtUtc, updatedAt: now, mutationStamp, deletedAt: null });
    await appendOutbox(tx, 'board', board.sourceId, mutationStamp, now);
    for (const period of board.periods) {
      const periodStamp = stamp();
      const periodId = await insertPeriod(tx, board.sourceId as BoardId, period.startDate as LogicalDate, periodStamp, period.endDate as LogicalDate | null);
      await appendOutbox(tx, 'activity_period', String(periodId), periodStamp, now);
    }
    summary.boardsCreated++;
  }
  for (const board of boards) if (board.anchorBoardId !== null) {
    await tx.runAsync('UPDATE boards SET anchor_board_id = ? WHERE id = ?', [board.anchorBoardId, board.sourceId]);
  }
  const checkScopes: { boardId: BoardId; logicalDate: LogicalDate }[] = [];
  for (const check of draft.checkIns) {
    if (!parentIds.has(check.sourceBoardId) || checkIds.has(check.sourceId)) {
      summary.checkInsSkipped = addSkipped(summary.checkInsSkipped, 1); continue;
    }
    const mutationStamp = stamp();
    await insertCheckIn(tx, { ...check, id: check.sourceId as CheckInId, boardId: check.sourceBoardId as BoardId,
      logicalDate: check.logicalDate as LogicalDate, idempotencyKey: deps.ids.uuid() as CommandId,
      createdAt: check.createdAtUtc, updatedAt: now, mutationStamp, deletedAt: null });
    await appendOutbox(tx, 'check_in', check.sourceId, mutationStamp, now);
    checkIds.add(check.sourceId); summary.checkInsCreated++;
    checkScopes.push({ boardId: check.sourceBoardId as BoardId, logicalDate: check.logicalDate as LogicalDate });
  }
  for (const reminder of draft.reminders) {
    if (!parentIds.has(reminder.sourceBoardId) || reminderIds.has(reminder.sourceId)) {
      summary.remindersSkipped = addSkipped(summary.remindersSkipped, 1); continue;
    }
    const mutationStamp = stamp();
    await insertReminder(tx, { ...reminder, id: reminder.sourceId as ReminderId, boardId: reminder.sourceBoardId as BoardId,
      nativeIdentifiers: [], scheduleState: 'idle', lastScheduleError: null,
      createdAt: reminder.createdAtUtc, updatedAt: now, mutationStamp, deletedAt: null });
    await appendOutbox(tx, 'reminder', reminder.sourceId, mutationStamp, now);
    reminderIds.add(reminder.sourceId); summary.remindersCreated++;
  }
  for (const reward of draft.rewards) {
    if (rewardIds.has(reward.sourceId)) { summary.v2.rewardsSkipped = addSkipped(summary.v2.rewardsSkipped, 1); continue; }
    const mutationStamp = stamp();
    await insertReward(tx, { ...reward, id: reward.sourceId as RewardId,
      archivedAt: reward.archivedAtUtc, createdAt: reward.createdAtUtc, updatedAt: now, mutationStamp, deletedAt: null });
    await appendOutbox(tx, 'reward', reward.sourceId, mutationStamp, now);
    rewardIds.add(reward.sourceId); summary.v2.rewardsCreated++;
  }
  const result = await admitRemoteFacts(tx, { candidates: evidence.value, acquiredNow: now, checkScopes }, deps.hashing);
  for (const fact of [...result.admitted, ...result.generated]) context.observeStamp(fact.mutationStamp);
  await refreshCheckVisibility(tx, [...checkScopes, ...result.affected.checkScopes]);
  await rebuildWidgetRows(tx, now, timeZoneId);
  summary.v2.immutable = { admitted: result.admitted.length, generated: result.generated.length,
    duplicates: result.duplicates.length, pending: result.counts.pending, blocked: result.counts.blocked,
    quarantined: result.counts.quarantined };
  return ok(summary);
}
