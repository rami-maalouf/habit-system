import type { ActivityPeriodRange } from '../../calendar/periods';
import { isValidLogicalDate } from '../../calendar/logical-date';
import { isUuidV4, type BoardId, type LogicalDate } from '../../domain/ids';
import { missAlertIdentifier, parseMissAlertIdentifier, type MissAlertBoard } from '../../domain/miss-alerts';
import type { MissAlertPair } from '../../domain/ports';
import { validateStartOfDayMinute } from '../../domain/validation';
import type { SqlExecutor } from '../database';

export type MissAlertStatus = 'pending' | 'scheduled' | 'denied' | 'error';
export type MissAlertRow = MissAlertPair & (
  | Readonly<{ status: 'pending' | 'error'; nativeIdentifier: string | null }>
  | Readonly<{ status: 'scheduled'; nativeIdentifier: string }>
  | Readonly<{ status: 'denied'; nativeIdentifier: null }>
);
const invalid = () => new Error('Stored miss alert data is invalid.');
const columns = 'board_id AS boardId, second_missed_date AS secondMissedDate, native_identifier AS nativeIdentifier, status';

function checkedPair(pair: MissAlertPair): MissAlertPair {
  const parsed = parseMissAlertIdentifier(missAlertIdentifier(pair));
  if (!parsed) throw invalid();
  return parsed;
}
function checkedRow(row: MissAlertRow): MissAlertRow {
  const pair = checkedPair(row);
  const { status, nativeIdentifier } = row;
  if (!['pending', 'scheduled', 'denied', 'error'].includes(status) ||
    (nativeIdentifier !== null && nativeIdentifier !== missAlertIdentifier(pair)) ||
    (status === 'scheduled' && nativeIdentifier === null) ||
    (status === 'denied' && nativeIdentifier !== null)) throw invalid();
  return { ...pair, status, nativeIdentifier } as MissAlertRow;
}
const pairKeys = (pairs: readonly MissAlertPair[]) => [...new Map(pairs.map(({ boardId, secondMissedDate }) =>
  [`${boardId}:${secondMissedDate}`, { boardId, secondMissedDate }])).values()];

export async function readMissAlertRows(tx: SqlExecutor, pairs: readonly MissAlertPair[]): Promise<MissAlertRow[]> {
  const keys = pairKeys(pairs);
  if (keys.length === 0) return [];
  const rows = await tx.getAllAsync<MissAlertRow>(`SELECT ${columns} FROM miss_alerts
    WHERE (board_id, second_missed_date) IN (SELECT json_extract(value, '$.boardId'),
      json_extract(value, '$.secondMissedDate') FROM json_each(?))
    ORDER BY board_id, second_missed_date`, [JSON.stringify(keys)]);
  return rows.map(checkedRow);
}

export async function readUnresolvedMissAlertRows(tx: SqlExecutor): Promise<MissAlertRow[]> {
  const rows = await tx.getAllAsync<MissAlertRow>(`SELECT ${columns} FROM miss_alerts
    WHERE status IN ('pending', 'error') AND native_identifier IS NOT NULL ORDER BY board_id, second_missed_date`);
  return rows.map(checkedRow);
}

export async function replaceMissAlertRow(tx: SqlExecutor, expected: MissAlertRow | null, next: MissAlertRow): Promise<boolean> {
  const row = checkedRow(next);
  const prior = expected === null ? null : checkedRow(expected);
  if (prior !== null && (prior.boardId !== row.boardId || prior.secondMissedDate !== row.secondMissedDate)) throw invalid();
  const result = prior === null ? await tx.runAsync(`INSERT INTO miss_alerts (board_id, second_missed_date, native_identifier, status)
    VALUES (?, ?, ?, ?) ON CONFLICT(board_id, second_missed_date) DO NOTHING`,
  [row.boardId, row.secondMissedDate, row.nativeIdentifier, row.status])
    : await tx.runAsync(`UPDATE miss_alerts SET native_identifier = ?, status = ?
      WHERE board_id = ? AND second_missed_date = ? AND status = ? AND native_identifier IS ?
      AND (native_identifier IS NOT ? OR status != ?)`,
    [row.nativeIdentifier, row.status, row.boardId, row.secondMissedDate, prior.status, prior.nativeIdentifier,
      row.nativeIdentifier, row.status]);
  return result.changes > 0;
}

export async function readMissAlertBoards(tx: SqlExecutor, extraBoardIds: readonly BoardId[]): Promise<MissAlertBoard[]> {
  const rows = await tx.getAllAsync<MissAlertBoard>(`SELECT id, kind, title, start_of_day_minute AS startOfDayMinute,
    archived_at AS archivedAt, deleted_at AS deletedAt FROM boards
    WHERE (kind = 'daily' AND archived_at IS NULL AND deleted_at IS NULL)
      OR id IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify([...new Set(extraBoardIds)])]);
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id.length !== 36 || !isUuidV4(row.id) ||
      !['daily', 'count'].includes(row.kind) || typeof row.title !== 'string' ||
      !validateStartOfDayMinute(row.startOfDayMinute).ok ||
      ![row.archivedAt, row.deletedAt].every(value => value === null ||
        (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000))) throw invalid();
  }
  return rows;
}

export async function readMissAlertPeriods(tx: SqlExecutor, boardIds: readonly BoardId[]): Promise<{ boardId: BoardId; periods: ActivityPeriodRange[] }[]> {
  const ids = [...new Set(boardIds)];
  if (ids.length === 0) return [];
  const rows = await tx.getAllAsync<ActivityPeriodRange & { boardId: BoardId }>(`SELECT board_id AS boardId,
    start_date AS startDate, end_date AS endDate FROM board_activity_periods
    WHERE deleted_at IS NULL AND board_id IN (SELECT value FROM json_each(?)) ORDER BY board_id, start_date, id`,
  [JSON.stringify(ids)]);
  const grouped = new Map<BoardId, ActivityPeriodRange[]>(ids.map(id => [id, []]));
  for (const row of rows) {
    checkedPair({ boardId: row.boardId, secondMissedDate: row.startDate });
    if (row.endDate !== null && (typeof row.endDate !== 'string' || row.endDate.length !== 10 || !isValidLogicalDate(row.endDate))) throw invalid();
    grouped.get(row.boardId)!.push({ startDate: row.startDate, endDate: row.endDate });
  }
  return [...grouped].map(([boardId, periods]) => ({ boardId, periods }));
}

export async function readEffectiveMissAlertDates(tx: SqlExecutor, dates: readonly { boardId: BoardId; logicalDate: LogicalDate }[]): Promise<{ boardId: BoardId; logicalDate: LogicalDate }[]> {
  const keys = dates.map(({ boardId, logicalDate }) => ({ boardId, logicalDate }));
  if (keys.length === 0) return [];
  const rows = await tx.getAllAsync<{ boardId: BoardId; logicalDate: LogicalDate }>(`SELECT DISTINCT board_id AS boardId, logical_date AS logicalDate
    FROM check_ins WHERE deleted_at IS NULL AND state_suppressed = 0
      AND (board_id, logical_date) IN (SELECT json_extract(value, '$.boardId'), json_extract(value, '$.logicalDate') FROM json_each(?))
    ORDER BY board_id, logical_date`, [JSON.stringify(keys)]);
  return rows.map(row => {
    checkedPair({ boardId: row.boardId, secondMissedDate: row.logicalDate });
    return row;
  });
}
