import { IMMUTABLE_FIELD_MAP } from './immutable-records';
import { specFor } from './records';
import type { SyncEntityType, SyncRecord } from './transport';

export type Schema2SyncEntityType = SyncEntityType | 'reward' | 'habit_action' | 'ledger_entry';
export type Schema2SyncRecord = Omit<SyncRecord, 'entityType'> & { entityType: Schema2SyncEntityType };
type TableSpec = ReturnType<typeof specFor>;

const specs: Record<Schema2SyncEntityType, TableSpec> = {
  board: {
    ...specFor('board'),
    columns: [...specFor('board').columns, 'kind', 'anchor_relation', 'anchor_kind',
      'anchor_board_id', 'anchor_preset', 'anchor_text', 'usual_time_minute',
      'required_in_stack', 'earns_coins', 'coin_cap_per_day'],
    userContent: { ...specFor('board').userContent, kind: 'count', anchor_relation: null,
      anchor_kind: null, anchor_board_id: null, anchor_preset: null, anchor_text: null,
      usual_time_minute: null, required_in_stack: 0, earns_coins: 0, coin_cap_per_day: 1 },
  },
  check_in: specFor('check_in'),
  activity_period: specFor('activity_period'),
  reminder: specFor('reminder'),
  settings: {
    ...specFor('settings'),
    columns: ['metrics_education_dismissed', 'wake_minute', 'lunch_minute', 'dinner_minute', 'sleep_minute'],
  },
  reward: {
    table: 'rewards', idColumn: 'id',
    columns: ['id', 'title', 'cost_coins', 'symbol', 'accent_hex', 'order_key',
      'archived_at', 'created_at', 'updated_at', 'deleted_at'],
    userContent: { title: '', cost_coins: 1, symbol: '', accent_hex: '', archived_at: null },
  },
  habit_action: { table: 'habit_actions', idColumn: 'id',
    columns: Object.keys(IMMUTABLE_FIELD_MAP.habit_action), userContent: {} },
  ledger_entry: { table: 'coin_ledger', idColumn: 'id',
    columns: Object.keys(IMMUTABLE_FIELD_MAP.ledger_entry), userContent: {} },
};

export function schema2SpecFor(entityType: Schema2SyncEntityType): TableSpec {
  return specs[entityType];
}

// the coordinated engine switch owns activation; the legacy mapper remains version 1.
export function toSchema2SyncRecord(entityType: Schema2SyncEntityType, entityId: string,
  mutationStamp: string, row: Record<string, unknown>): Schema2SyncRecord {
  const spec = schema2SpecFor(entityType);
  const deleted = row.deleted_at !== null && row.deleted_at !== undefined;
  if (deleted && (entityType === 'habit_action' || entityType === 'ledger_entry')) {
    throw new Error('Immutable sync evidence cannot be deleted.');
  }
  const fields: SyncRecord['fields'] = {};
  for (const column of spec.columns) {
    const value = deleted && Object.hasOwn(spec.userContent, column)
      ? entityType === 'check_in' && column === 'idempotency_key' ? entityId : spec.userContent[column]
      : row[column];
    if (value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Invalid schema-2 sync field.');
    }
    fields[column] = value;
  }
  return { schemaVersion: 2, entityType, entityId, mutationStamp, deleted, fields };
}
