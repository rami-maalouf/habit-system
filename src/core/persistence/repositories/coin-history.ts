import type { CoinLedgerRow } from '../../domain/coin-ledger';
import { CoinContractError } from '../../domain/coin-policy';
import type { BoardId, LedgerEntryId, LogicalDate } from '../../domain/ids';
import type { SqlExecutor } from '../database';

export type CoinTotals = { earned: number; spent: number; balance: number };
export type CoinHistoryCursor = { logicalDate: LogicalDate; createdAt: number; id: LedgerEntryId };
export type CoinHistoryRecord = Pick<CoinLedgerRow, 'id' | 'kind' | 'delta' | 'boardId' | 'runKey' |
  'scopeKey' | 'rewardId' | 'rewardTitleSnapshot' | 'adjustsId' | 'logicalDate' | 'createdAt'>;
export type CoinHistoryBoard = { id: BoardId; title: string; archivedAt: number | null; deletedAt: number | null };

// reusable inside the exclusive claim transaction; no saved balance or proof payloads.
export async function readCoinTotals(tx: SqlExecutor): Promise<CoinTotals> {
  const row = (await tx.getFirstAsync<{ earned: string; spent: string }>(`SELECT
    CAST(COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS TEXT) AS earned,
    CAST(COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS TEXT) AS spent
    FROM coin_ledger`))!;
  // text keeps sqlite's exact integers intact across javascript bridge implementations.
  const totals = { earned: Number(row.earned), spent: Number(row.spent) };
  const balance = totals.earned - totals.spent;
  if (!Number.isSafeInteger(totals.earned) || !Number.isSafeInteger(totals.spent) ||
    !Number.isSafeInteger(balance)) throw new CoinContractError('size');
  return { ...totals, balance };
}

export async function readCoinHistoryRows(tx: SqlExecutor, limit: number, before?: CoinHistoryCursor): Promise<CoinHistoryRecord[]> {
  return tx.getAllAsync<CoinHistoryRecord>(`SELECT id, kind, delta, board_id AS boardId,
    run_key AS runKey, scope_key AS scopeKey, reward_id AS rewardId,
    reward_title_snapshot AS rewardTitleSnapshot, adjusts_id AS adjustsId,
    logical_date AS logicalDate, created_at AS createdAt
    FROM coin_ledger
    ${before ? 'WHERE (logical_date, created_at, id) < (?, ?, ?)' : ''}
    ORDER BY logical_date DESC, created_at DESC, id DESC LIMIT ?`,
  before ? [before.logicalDate, before.createdAt, before.id, limit] : [limit]);
}

export async function readCoinHistoryBoards(tx: SqlExecutor, ids: readonly BoardId[]): Promise<CoinHistoryBoard[]> {
  return tx.getAllAsync<CoinHistoryBoard>(`SELECT id, title, archived_at AS archivedAt, deleted_at AS deletedAt
    FROM boards WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
}
