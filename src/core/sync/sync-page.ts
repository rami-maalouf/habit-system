import type { FetchPage, WireSyncRecord } from './transport';

export const SYNC_RECORD_BYTES = 6 * 786_432 + 8_192;
export const SYNC_RECORD_COUNT = 200;
export const SYNC_TOKEN_BYTES = 1_048_576;
const legacyTypes = ['board', 'activity_period', 'check_in', 'reminder', 'settings'];
const currentTypes = [...legacyTypes, 'reward', 'habit_action', 'ledger_entry'];
const recordKeys = ['schemaVersion', 'entityType', 'entityId', 'mutationStamp', 'deleted', 'fields'];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function failure(): never { throw new Error('Invalid sync page.'); }
function boundedText(text: string, max: number) {
  // utf-16 length is a lower bound; reject large unknown strings before an encoded copy.
  if (text.length > max || new TextEncoder().encode(text).length > max) failure();
}
function captureRecord(value: unknown): WireSyncRecord {
  if (!object(value)) failure();
  const { schemaVersion, entityType, entityId, mutationStamp, deleted, fields } = value;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || typeof entityType !== 'string' ||
    !(schemaVersion === 1 ? legacyTypes : currentTypes).includes(entityType) ||
    typeof entityId !== 'string' || !entityId || typeof mutationStamp !== 'string' ||
    typeof deleted !== 'boolean' || !object(fields) ||
    (schemaVersion === 2 && (Object.keys(value).length !== recordKeys.length ||
      !recordKeys.every(key => Object.hasOwn(value, key))))) failure();
  const entries = Object.entries(fields);
  let characters = entityId.length + mutationStamp.length;
  for (const [key, field] of entries) {
    if (field !== null && typeof field !== 'string' && (typeof field !== 'number' || !Number.isFinite(field))) failure();
    characters += key.length + (typeof field === 'string' ? field.length : 0);
    if (characters > SYNC_RECORD_BYTES) failure();
  }
  const record = { schemaVersion, entityType, entityId, mutationStamp, deleted, fields: Object.fromEntries(entries) };
  boundedText(JSON.stringify(record), SYNC_RECORD_BYTES);
  return record as WireSyncRecord;
}

// transport objects are borrowed only until this synchronous complete-page snapshot returns.
// row/count/token bounds imply the native aggregate bound, including its syntax allowance.
export function captureSyncPage(value: unknown, previousToken: string | null): FetchPage<WireSyncRecord> {
  if (!object(value)) failure();
  const { records, nextToken, more } = value;
  const count = Array.isArray(records) ? records.length : -1;
  if (!Array.isArray(records) || !Number.isInteger(count) || count < 0 || count > SYNC_RECORD_COUNT ||
    (nextToken !== null && typeof nextToken !== 'string') || typeof more !== 'boolean' ||
    (more && (nextToken === null || nextToken === previousToken))) failure();
  if (nextToken !== null) boundedText(nextToken, SYNC_TOKEN_BYTES);
  const captured: WireSyncRecord[] = [];
  for (let index = 0; index < count; index++) captured.push(captureRecord(records[index]));
  return { records: captured, nextToken, more };
}
