import type { SqlExecutor } from '../database';

// local integer ids cannot disambiguate two retained intervals sharing a wire alias.
export async function readUniquePeriodAlias(tx: SqlExecutor, boardId: string, startDate: string) {
  const rows = await tx.getAllAsync<{ id: number; mutation_stamp: string }>(
    'SELECT id, mutation_stamp FROM board_activity_periods WHERE board_id = ? AND start_date = ? LIMIT 2',
    [boardId, startDate],
  );
  if (rows.length > 1) throw new Error('Activity period sync identity is ambiguous.');
  return rows[0] ?? null;
}
