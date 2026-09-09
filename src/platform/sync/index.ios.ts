import type { FetchPage, SyncFailureCode, SyncRecord, SyncTransport } from '@/core/sync/transport';
import { SyncTransportError } from '@/core/sync/transport';
import type { Schema2SyncRecord } from '@/core/sync/schema-2-records';

import nativeModule from './cloudkit-native';

const MESSAGES: Record<SyncFailureCode, string> = {
  offline: 'iCloud sync will try again when the connection returns.',
  signed_out: 'Sign in to iCloud in Settings to sync your data.',
  unavailable: 'iCloud sync is unavailable in this build or account.',
  failure: 'iCloud sync could not finish. Try again.',
};

function transportError(code: SyncFailureCode): SyncTransportError {
  return new SyncTransportError(code, MESSAGES[code]);
}

function requireTransport() {
  if (
    typeof nativeModule?.cloudKitAvailable !== 'function' ||
    typeof nativeModule.cloudKitEnsureZone !== 'function' ||
    typeof nativeModule.cloudKitUpload !== 'function' ||
    typeof nativeModule.cloudKitFetchChanges !== 'function'
  ) {
    throw transportError('unavailable');
  }
  return nativeModule as Required<NonNullable<typeof nativeModule>>;
}

async function callNative<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let code: unknown;
    try { code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null; }
    catch { code = null; }
    throw transportError(
      code === 'offline' || code === 'signed_out' || code === 'unavailable' ? code : 'failure',
    );
  }
}

export async function cloudKitAvailable(): Promise<boolean> {
  try {
    return (await requireTransport().cloudKitAvailable()) === true;
  } catch {
    return false;
  }
}

// paired with the native cloudkit wire codec; token allowance is independent of rows.
const ROW_BYTES = 6 * 786_432 + 8_192;
const RECORD_COUNT = 200;
const TOKEN_BYTES = 1_048_576;
const SYNTAX_BYTES = 8_192;
const UPLOAD_BYTES = RECORD_COUNT * ROW_BYTES + SYNTAX_BYTES;
const PAGE_BYTES = UPLOAD_BYTES + 6 * TOKEN_BYTES;
const LEGACY_TYPES = ['board', 'activity_period', 'check_in', 'reminder', 'settings'];
const IMMUTABLE_TYPES = ['habit_action', 'ledger_entry'];
const VERSION_TWO_TYPES = [...LEGACY_TYPES, 'reward', ...IMMUTABLE_TYPES];
const RECORD_KEYS = ['schemaVersion', 'entityType', 'entityId', 'mutationStamp', 'deleted', 'fields'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Schema2Page = Omit<FetchPage, 'records'> & { records: Schema2SyncRecord[] };
type Schema2Transport = {
  ensureZone(): Promise<void>;
  upload(records: readonly Schema2SyncRecord[]): Promise<void>;
  fetchChanges(token: string | null): Promise<Schema2Page>;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function bytes(value: string, limit = ROW_BYTES): number {
  // count utf-8 without allocating a second copy of an untrusted page/string.
  let size = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      size += 4; index += 1;
    } else size += 3;
    if (size > limit) break;
  }
  return size;
}

function checkToken(token: unknown): asserts token is string | null {
  if (token !== null && (typeof token !== 'string' || bytes(token, TOKEN_BYTES) > TOKEN_BYTES)) throw transportError('failure');
}

function captureRecord(value: unknown, outbound: boolean): Schema2SyncRecord {
  if (!object(value) || !exactKeys(value, RECORD_KEYS)) throw transportError('failure');
  const { schemaVersion, entityType, entityId, mutationStamp, deleted, fields: inputFields } = value;
  const types = schemaVersion === 1 ? LEGACY_TYPES : schemaVersion === 2 ? VERSION_TWO_TYPES : [];
  if (typeof entityType !== 'string' || !types.includes(entityType) || typeof entityId !== 'string' ||
    entityId.length === 0 || bytes(entityId, 255) > 255 || typeof mutationStamp !== 'string' ||
    (schemaVersion === 1 && mutationStamp.length === 0) || typeof deleted !== 'boolean' || !object(inputFields) ||
    (IMMUTABLE_TYPES.includes(entityType) && !UUID.test(entityId))) throw transportError('failure');
  let size = bytes(entityType) + bytes(entityId) + bytes(mutationStamp);
  if (size > ROW_BYTES) throw transportError('failure');
  const fields: SyncRecord['fields'] = {};
  for (const key of Object.keys(inputFields)) {
    const field = inputFields[key];
    if (field !== null && typeof field !== 'string' && (typeof field !== 'number' || !Number.isFinite(field))) {
      throw transportError('failure');
    }
    // immutable outgoing numbers must survive json without signed-zero repair.
    if (outbound && IMMUTABLE_TYPES.includes(entityType) && typeof field === 'number' &&
      (!Number.isSafeInteger(field) || Object.is(field, -0))) throw transportError('failure');
    size += bytes(key) + (typeof field === 'string' ? bytes(field) : 0);
    if (size > ROW_BYTES) throw transportError('failure');
    Object.defineProperty(fields, key, { value: field, enumerable: true, writable: true, configurable: true });
  }
  const record = { schemaVersion, entityType, entityId, mutationStamp, deleted, fields } as Schema2SyncRecord;
  if (bytes(JSON.stringify(record)) > ROW_BYTES) throw transportError('failure');
  return record;
}

function captureRecords(value: unknown, outbound: boolean): Schema2SyncRecord[] {
  if (!Array.isArray(value)) throw transportError('failure');
  const count = value.length;
  if (!Number.isInteger(count) || count < 0 || count > RECORD_COUNT) throw transportError('failure');
  const records: Schema2SyncRecord[] = [];
  for (let index = 0; index < count; index += 1) records.push(captureRecord(value[index], outbound));
  return records;
}

function decodePage(json: unknown, previousToken: string | null): Schema2Page {
  if (typeof json !== 'string' || bytes(json, PAGE_BYTES) > PAGE_BYTES) throw transportError('failure');
  const value: unknown = JSON.parse(json);
  if (!object(value) || !exactKeys(value, ['records', 'nextToken', 'more'])) throw transportError('failure');
  const { records: inputs, nextToken, more } = value;
  checkToken(nextToken);
  if (typeof more !== 'boolean' || (more && (nextToken === null || nextToken === previousToken))) throw transportError('failure');
  const records = captureRecords(inputs, false);
  // exact keys, bounded token and <=200 row separators fit the native syntax allowance.
  return { records, nextToken, more };
}

function uploadRecords(records: unknown): Promise<void> {
  return callNative(() => {
    const captured = captureRecords(records, true);
    const json = JSON.stringify(captured);
    // bounded encoded rows plus array separators fit upload_bytes without another copy.
    return requireTransport().cloudKitUpload(json);
  });
}

export const schema2CloudKitTransport: Schema2Transport = {
  async ensureZone(): Promise<void> {
    await callNative(() => requireTransport().cloudKitEnsureZone());
  },
  async upload(records): Promise<void> {
    await uploadRecords(records);
  },
  async fetchChanges(token): Promise<Schema2Page> {
    return callNative(async () => {
      checkToken(token);
      return decodePage(await requireTransport().cloudKitFetchChanges(token), token);
    });
  },
};

// the coordinated engine consumes all supported versions through this default port.
export const cloudKitTransport: SyncTransport<Schema2SyncRecord> = schema2CloudKitTransport;

// ios-only feature; android sync is out of scope for this release
export const syncSupportedPlatform = true;
