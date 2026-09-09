import { captureOwnV2ImportDraft, type ImportDraft, type LegacyImportDraft } from './import-parsers';
import { err, ok, type DomainResult } from '../domain/result';

const BOARD_FIELDS = ['sourceId', 'title', 'symbol', 'accentHex', 'usesTintedBackground', 'tracksAmount',
  'amountUnit', 'quickAmount', 'tracksTime', 'startOfDayMinute', 'metricsEnabled', 'createdAtUtc',
  'archivedAtUtc', 'preserveId', 'orderKey'] as const;
const CHECK_FIELDS = ['sourceId', 'sourceBoardId', 'occurredAtUtc', 'createdAtUtc', 'amount', 'note',
  'logicalDate', 'timeZoneId', 'offsetMinutes', 'preserveId'] as const;
const REMINDER_FIELDS = ['sourceId', 'sourceBoardId', 'weekdaysMask', 'minuteOfDay', 'message', 'enabled', 'createdAtUtc'] as const;

function scalarFields(value: unknown, keys: readonly string[]): Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid import record.');
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) throw new Error('Invalid import record.');
    const item = source[key];
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error('Invalid import value.');
    }
    result[key] = item;
  }
  return result;
}

function legacyPeriod(value: unknown): { startDate: string; endDate: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { startDate: 'invalid', endDate: null };
  const startDate = Object.hasOwn(value, 'startDate') ? (value as { startDate: unknown }).startDate : null;
  const endDate = Object.hasOwn(value, 'endDate') ? (value as { endDate: unknown }).endDate : undefined;
  if (typeof startDate !== 'string' || (endDate !== null && typeof endDate !== 'string')) return { startDate: 'invalid', endDate: null };
  return { startDate, endDate };
}

function copyArray<T>(values: unknown, copy: (value: unknown) => T): T[] {
  if (!Array.isArray(values)) throw new Error('Invalid import collection.');
  const length = values.length;
  const result: T[] = [];
  for (let index = 0; index < length; index++) result.push(copy(values[index]));
  return result;
}

// only captured allowlisted objects reach this recursion; opaque evidence is a string.
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}

export function captureImportDraft(draft: ImportDraft): DomainResult<ImportDraft> {
  try {
    const source = draft.source;
    const version = draft.exportVersion;
    if (source !== 'own' && source !== 'ripples-csv') throw new Error('Invalid import source.');
    let captured: ImportDraft;
    if (version === 2) {
      captured = captureOwnV2ImportDraft(draft as Extract<ImportDraft, { exportVersion: 2 }>);
    } else {
      if (version !== undefined && version !== 1) throw new Error('Invalid import version.');
      const boards = copyArray(draft.boards, value => {
        const row = scalarFields(value, BOARD_FIELDS);
        const periods = (value as LegacyImportDraft['boards'][number]).periods;
        return { ...row, periods: periods === null ? null
          : copyArray(periods, legacyPeriod) };
      }) as LegacyImportDraft['boards'];
      captured = { source, boards,
        checkIns: copyArray(draft.checkIns, value => scalarFields(value, CHECK_FIELDS)) as LegacyImportDraft['checkIns'],
        reminders: copyArray(draft.reminders, value => scalarFields(value, REMINDER_FIELDS)) as LegacyImportDraft['reminders'] };
      if (version === 1) captured.exportVersion = 1;
    }
    freeze(captured);
    return ok(captured);
  } catch { return err('validation', 'This import data is invalid. Choose the file again.'); }
}
