import type { ActivityPeriodRange } from '../../calendar/periods';
import type { BoardId, LogicalDate } from '../../domain/ids';
import type { SqlExecutor } from '../database';

export async function readCoinPolicyPeriods(
  tx: SqlExecutor,
  boardIds: readonly BoardId[],
): Promise<Map<BoardId, ActivityPeriodRange[]>> {
  const rows = await tx.getAllAsync<{ board_id: BoardId; start_date: LogicalDate; end_date: LogicalDate | null }>(
    `SELECT board_id, start_date, end_date FROM board_activity_periods
     WHERE deleted_at IS NULL AND board_id IN (SELECT value FROM json_each(?))
     ORDER BY board_id, start_date`,
    [JSON.stringify(boardIds)],
  );
  const periods = new Map<BoardId, ActivityPeriodRange[]>();
  for (const row of rows) {
    const ranges = periods.get(row.board_id) ?? [];
    ranges.push({ startDate: row.start_date, endDate: row.end_date });
    periods.set(row.board_id, ranges);
  }
  return periods;
}
