import { isValidLogicalDate } from '../calendar/logical-date';
import type { BoardId, CheckInId, LogicalDate } from '../domain/ids';
import type { SqlExecutor } from '../persistence/database';
import { deleteDeferredRecord, getDeferredMutationStamp, listDeferredRecords, saveDeferredRecord } from '../persistence/repositories/support';
import { readUniquePeriodAlias } from '../persistence/repositories/sync-periods';
import { validateLegacyRecordForSchema2, validateSchema2MutableRecord, type Schema2MutableRecord } from './inbound-validation';
import { parsePeriodEntityId } from './records';
import { schema2SpecFor } from './schema-2-records';
import { readSyncBoardGraph, type SyncBoardGraph } from './sync-board-graph';

type CheckScope = { boardId: BoardId; logicalDate: LogicalDate };
type AppliedChecks = { scopes: Map<string, CheckScope>; legacy: Map<string, CheckScope & { id: CheckInId }>; changed: boolean; stamps: string[] };
function appliedChecks(): AppliedChecks { return { scopes: new Map(), legacy: new Map(), changed: false, stamps: [] }; }
function retainScope(changes: AppliedChecks, boardId: string, logicalDate: string) {
  if (isValidLogicalDate(logicalDate)) changes.scopes.set(`${boardId}:${logicalDate}`, { boardId: boardId as BoardId, logicalDate: logicalDate as LogicalDate });
}
async function localStampFor(
  tx: SqlExecutor,
  record: Schema2MutableRecord,
): Promise<{ exists: boolean; stamp: string | null; localId: string | null; checkScope?: CheckScope }> {
  if (record.entityType === 'settings') {
    const row = await tx.getFirstAsync<{ mutation_stamp: string | null }>(
      'SELECT settings_mutation_stamp AS mutation_stamp FROM app_settings WHERE id = 1',
    );
    return { exists: row !== null, stamp: row?.mutation_stamp ?? null, localId: '1' };
  }
  if (record.entityType === 'activity_period') {
    const parsed = parsePeriodEntityId(record.entityId) as {
      boardId: string;
      startDate: string;
    };
    const row = await readUniquePeriodAlias(tx, parsed.boardId, parsed.startDate);
    return {
      exists: row !== null,
      stamp: row?.mutation_stamp ?? null,
      localId: row ? String(row.id) : null,
    };
  }
  const spec = schema2SpecFor(record.entityType);
  const row = await tx.getFirstAsync<{ mutation_stamp: string; board_id: BoardId; logical_date: LogicalDate }>(
    `SELECT mutation_stamp${record.entityType === 'check_in' ? ', board_id, logical_date' : ''} FROM ${spec.table} WHERE ${spec.idColumn} = ?`,
    [record.entityId],
  );
  return {
    exists: row !== null && row !== undefined,
    stamp: row?.mutation_stamp ?? null,
    localId: row ? record.entityId : null,
    checkScope: row && record.entityType === 'check_in' ? { boardId: row.board_id, logicalDate: row.logical_date } : undefined,
  };
}

async function applyRecord(
  tx: SqlExecutor,
  record: Schema2MutableRecord,
  now: number,
  changes: AppliedChecks,
  graph: SyncBoardGraph,
): Promise<boolean | 'graph_wait'> {
  const local = await localStampFor(tx, record);
  // whole-record last-writer-wins on the lexicographic stamp; equal stamps
  // are the same mutation and need no write
  if (local.exists && local.stamp !== null && local.stamp >= record.mutationStamp) {
    return false;
  }
  if (record.entityType === 'board' && !graph.allows(record)) return 'graph_wait';

  if (record.entityType === 'settings') {
    await tx.runAsync(
      'UPDATE app_settings SET metrics_education_dismissed = ?, wake_minute = ?, lunch_minute = ?, dinner_minute = ?, sleep_minute = ?, settings_mutation_stamp = ? WHERE id = 1',
      [
        record.fields.metrics_education_dismissed as string,
        ...['wake_minute', 'lunch_minute', 'dinner_minute', 'sleep_minute'].map(key => record.fields[key]),
        record.mutationStamp,
      ],
    );
    return true;
  }

  const spec = schema2SpecFor(record.entityType);
  const columns = spec.columns.filter((column) => column !== spec.idColumn);
  // `deleted` is authoritative: a stripped tombstone whose deleted_at field
  // was lost in transit must never come back to life, and a live record
  // must never inherit a stale deleted_at
  const deletedAt = record.deleted
    ? (typeof record.fields.deleted_at === 'number' ? record.fields.deleted_at : now)
    : null;
  const values = columns.map((column) =>
    column === 'deleted_at' ? deletedAt : (record.fields[column] ?? null),
  );

  if (record.entityType === 'activity_period') {
    const parsed = parsePeriodEntityId(record.entityId) as {
      boardId: string;
      startDate: string;
    };
    if (local.exists) {
      await tx.runAsync(
        `UPDATE board_activity_periods SET end_date = ?, deleted_at = ?, mutation_stamp = ?
         WHERE id = ?`,
        [record.fields.end_date ?? null, deletedAt, record.mutationStamp, local.localId],
      );
      return true;
    }
    await tx.runAsync(
      `INSERT INTO board_activity_periods (board_id, start_date, end_date, mutation_stamp, deleted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        parsed.boardId,
        parsed.startDate,
        record.fields.end_date ?? null,
        record.mutationStamp,
        deletedAt,
      ],
    );
    return true;
  }

  if (record.entityType === 'check_in') {
    if (local.checkScope) retainScope(changes, local.checkScope.boardId, local.checkScope.logicalDate);
    const boardId = record.fields.board_id as BoardId;
    const logicalDate = record.fields.logical_date as LogicalDate;
    retainScope(changes, boardId, logicalDate);
    changes.legacy.delete(record.entityId);
    if (!record.deleted && record.schemaVersion === 1) {
      changes.legacy.set(record.entityId, { id: record.entityId as CheckInId, boardId, logicalDate });
    }
  }
  if (local.exists) {
    const assignments = columns.map((column) => `${column} = ?`).join(', ');
    await tx.runAsync(
      `UPDATE ${spec.table} SET ${assignments}, mutation_stamp = ?${record.entityType === 'check_in' ? ', state_suppressed = 1' : ''} WHERE ${spec.idColumn} = ?`,
      [...values, record.mutationStamp, record.entityId],
    );
    return true;
  }

  const insertColumns = [spec.idColumn, ...columns, 'mutation_stamp'];
  const insertValues: (string | number | null)[] = [
    record.entityId,
    ...values,
    record.mutationStamp,
  ];
  if (record.entityType === 'reminder') {
    insertColumns.push('schedule_state', 'last_schedule_error');
    insertValues.push('idle', null);
  }
  const placeholders = insertColumns.map(() => '?').join(', ');
  await tx.runAsync(
    `INSERT INTO ${spec.table} (${insertColumns.join(', ')}) VALUES (${placeholders})`,
    insertValues,
  );
  return true;
}

// a remote record can only be applied once its board exists locally, so
// dependents wait for their parent within the same commit
function applyOrder(records: Schema2MutableRecord[]): Schema2MutableRecord[] {
  const weight: Record<Schema2MutableRecord['entityType'], number> = {
    board: 0,
    activity_period: 1,
    check_in: 2,
    reminder: 3,
    settings: 4, reward: 4,
  };
  return [...records].sort((a, b) => weight[a.entityType] - weight[b.entityType]);
}

// a fetched record can arrive before its parent board. applying it would
// violate the foreign key and roll back the whole page, and because the
// change token never advances that page would fail forever. the record
// waits in sync_deferred instead and is retried on every later pass.
async function applyWithDeferral(
  tx: SqlExecutor,
  record: Schema2MutableRecord,
  now: number,
  changes: AppliedChecks,
  graph: SyncBoardGraph,
): Promise<ApplyResult> {
  const deferredStamp = await getDeferredMutationStamp(tx, record.entityType, record.entityId);
  if (deferredStamp !== null && deferredStamp > record.mutationStamp) {
    return { applied: false, observedStamp: null };
  }
  const applied = await applyRecord(tx, record, now, changes, graph);
  if (applied === 'graph_wait') {
    await deferRecord(tx, record, now, changes);
    return { applied: false, observedStamp: null, graphWaiting: record };
  }
  await deleteDeferredRecord(tx, record.entityType, record.entityId);
  changes.changed ||= applied || deferredStamp !== null;
  return { applied, observedStamp: record.mutationStamp,
    graphChanged: applied && record.entityType === 'board' && graph.commit(record) };
}

async function deferRecord(tx: SqlExecutor, record: Schema2MutableRecord, now: number, changes: AppliedChecks): Promise<void> {
  const local = await localStampFor(tx, record);
  const deferredStamp = await getDeferredMutationStamp(tx, record.entityType, record.entityId);
  if (local.stamp !== null && local.stamp >= record.mutationStamp) {
    if (deferredStamp === null || local.stamp >= deferredStamp) {
      await deleteDeferredRecord(tx, record.entityType, record.entityId);
      changes.changed ||= deferredStamp !== null;
    }
    return;
  }
  if (deferredStamp !== null && deferredStamp >= record.mutationStamp) {
    return;
  }
  changes.changed = true;
  await saveDeferredRecord(tx, {
    entityType: record.entityType,
    entityId: record.entityId,
    mutationStamp: record.mutationStamp,
    payload: JSON.stringify(record),
    firstSeenAt: now,
  });
}

type ApplyResult = { applied: boolean; observedStamp: string | null; waiting?: Schema2MutableRecord;
  graphWaiting?: Schema2MutableRecord; graphChanged?: boolean };

async function validateAndApply(
  tx: SqlExecutor,
  value: unknown,
  now: number,
  changes: AppliedChecks,
  graph: SyncBoardGraph,
): Promise<ApplyResult> {
  const validation = typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === 1
    ? await validateLegacyRecordForSchema2(tx, value) : await validateSchema2MutableRecord(tx, value);
  if (validation.kind === 'unidentifiable') {
    throw new Error('invalid sync envelope');
  }
  if (validation.kind === 'invalid' || validation.kind === 'deferred') {
    await deferRecord(tx, validation.record, now, changes);
    return { applied: false, observedStamp: null,
      ...(validation.kind === 'deferred' ? { waiting: validation.record } : {}) };
  }
  return applyWithDeferral(tx, validation.record, now, changes, graph);
}

// complete the captured acyclic mutable dependencies without a persistent work queue.
export async function applyMutableSyncPage(tx: SqlExecutor, records: Schema2MutableRecord[], now: number,
  checkpoint: () => void) {
  const changes = appliedChecks();
  const graph = await readSyncBoardGraph(tx);
  let applied = 0;
  const queue: unknown[] = applyOrder(records);
  for (const row of await listDeferredRecords(tx)) {
    checkpoint();
    try { queue.push(JSON.parse(row.payload)); } catch { /* an unreadable retained legacy row stays deferred. */ }
  }
  const waiting = new Map<string, Map<string, Schema2MutableRecord>>();
  const graphWaiting = new Map<string, Schema2MutableRecord>();
  for (let index = 0; index < queue.length; index++) {
    const value = queue[index];
    checkpoint();
    const result = await validateAndApply(tx, value, now, changes, graph);
    checkpoint();
    if (result.observedStamp !== null) changes.stamps.push(result.observedStamp);
    if (result.graphWaiting) {
      const record = result.graphWaiting;
      const prior = graphWaiting.get(record.entityId);
      if (!prior || prior.mutationStamp < record.mutationStamp) graphWaiting.set(record.entityId, record);
    }
    if (result.graphChanged) {
      // a clear anywhere along a target chain can unblock a retained board winner.
      queue.push(...graphWaiting.values()); graphWaiting.clear();
    }
    if (result.waiting) {
      const record = result.waiting;
      const parentId = (record.entityType === 'board' ? record.fields.anchor_board_id
        : record.entityType === 'activity_period' ? parsePeriodEntityId(record.entityId)!.boardId : record.fields.board_id) as string;
      const bucket = waiting.get(parentId) ?? new Map<string, Schema2MutableRecord>();
      const key = `${record.entityType}:${record.entityId}`;
      const prior = bucket.get(key);
      if (!prior || prior.mutationStamp < record.mutationStamp) bucket.set(key, record);
      waiting.set(parentId, bucket);
    }
    if (result.applied) {
      applied++;
      // a successful board merge can unblock only records waiting for that identity.
      const record = value as Schema2MutableRecord;
      if (record.entityType === 'board') {
        const dependents = waiting.get(record.entityId);
        if (dependents) { queue.push(...dependents.values()); waiting.delete(record.entityId); }
      }
    }
  }
  return { applied, localChanged: changes.changed, observedStamps: changes.stamps,
    checkScopes: [...changes.scopes.values()], legacyChecks: [...changes.legacy.values()] };
}
