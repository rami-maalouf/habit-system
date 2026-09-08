import { nextWidgetRefreshUtc } from '../calendar/widget-refresh';
import { readWidgetRows, rebuildWidgetRows } from '../persistence/projections/widget-rows';
import { listActiveBoards } from '../persistence/repositories/boards';
import type { WidgetBoardRow } from './entities';
import type { QueryDeps } from './queries';
import type { DomainResult } from './result';
import { err, ok } from './result';

export type WidgetProjectionSnapshot = {
  rows: WidgetBoardRow[];
  generatedAtUtc: number;
  // a conservative display refresh deadline, not an economic day close.
  expiresAtUtc: number;
};

// only derived cache rows change; semantic mutations keep their own receipts.
export async function refreshWidgetProjection(deps: QueryDeps): Promise<DomainResult<WidgetProjectionSnapshot>> {
  try {
    return ok(await deps.db.withExclusiveTransactionAsync(async (tx) => {
      const generatedAtUtc = deps.clock.nowUtcMs();
      const timeZoneId = deps.clock.timeZoneId();
      const boards = await listActiveBoards(tx);
      const expiresAtUtc = nextWidgetRefreshUtc(generatedAtUtc, timeZoneId, boards.map((board) => board.startOfDayMinute));
      await rebuildWidgetRows(tx, generatedAtUtc, timeZoneId, boards);
      return { rows: await readWidgetRows(tx), generatedAtUtc, expiresAtUtc };
    }));
  } catch (cause) {
    return err('database', `The widget could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: true });
  }
}
