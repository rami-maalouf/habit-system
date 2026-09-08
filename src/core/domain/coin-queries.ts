import { isValidLogicalDate } from '../calendar/logical-date';
import { readCoinHistoryBoards, readCoinHistoryRows, readCoinTotals } from '../persistence/repositories/coin-history';
import type { CoinHistoryBoard, CoinHistoryCursor, CoinHistoryRecord, CoinTotals } from '../persistence/repositories/coin-history';
import type { CoinLedgerRow } from './coin-ledger';
import { CoinContractError } from './coin-policy';
import { isUuidV4, isUuidV5, type BoardId, type LedgerEntryId, type LogicalDate, type RewardId } from './ids';
import { runQuery, type QueryDeps } from './queries';
import { err, ok, type DomainResult } from './result';

export type { CoinHistoryCursor, CoinTotals } from '../persistence/repositories/coin-history';
export type CoinHistoryReference =
  | { kind: 'habit' | 'stack'; id: BoardId; title: string | null; status: 'active' | 'archived' | 'deleted' | 'missing' }
  | { kind: 'reward'; id: RewardId; title: string };
export type CoinHistoryItem = {
  id: LedgerEntryId; kind: CoinLedgerRow['kind']; delta: number; logicalDate: LogicalDate; createdAt: number;
  reference: CoinHistoryReference; adjustment: 'correction' | 'cancellation' | null;
};
export type CoinHistoryPage = { items: CoinHistoryItem[]; nextCursor: CoinHistoryCursor | null };
export type CoinHistoryInput = { limit?: number; before?: CoinHistoryCursor };

export async function getCoinTotals(deps: QueryDeps): Promise<DomainResult<CoinTotals>> {
  const result = await runQuery(deps, async tx => {
    try { return ok(await readCoinTotals(tx)); } catch (cause) {
      if (cause instanceof CoinContractError && cause.reason === 'size') {
        return err<CoinTotals>('capacity', 'Coin totals exceed the supported integer range.');
      }
      throw cause;
    }
  });
  return result.ok ? result.value : result;
}

function validCursor(cursor: CoinHistoryCursor): boolean {
  return typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor) &&
    Object.keys(cursor).length === 3 && ['logicalDate', 'createdAt', 'id'].every(key => Object.hasOwn(cursor, key)) &&
    typeof cursor.logicalDate === 'string' && isValidLogicalDate(cursor.logicalDate) &&
    Number.isSafeInteger(cursor.createdAt) && cursor.createdAt >= 0 && !Object.is(cursor.createdAt, -0) &&
    typeof cursor.id === 'string' && (isUuidV4(cursor.id) || isUuidV5(cursor.id));
}

// validate the displayed contract only; economic proofs remain at their acceptance boundary.
function referenceFor(row: CoinHistoryRecord): CoinHistoryReference {
  if (typeof row.id !== 'string' || !(row.kind === 'claim' ? isUuidV4(row.id) : isUuidV5(row.id)) ||
    !['check', 'run_bonus', 'claim', 'reversal', 'adjustment'].includes(row.kind) ||
    !Number.isSafeInteger(row.delta) || row.delta === 0 ||
    ((row.kind === 'check' || row.kind === 'run_bonus') ? row.delta !== 1 : row.kind !== 'adjustment' && row.delta > 0) ||
    typeof row.logicalDate !== 'string' || !isValidLogicalDate(row.logicalDate) ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || Object.is(row.createdAt, -0)) throw new CoinContractError('invalid');
  if (row.kind === 'claim') {
    if (typeof row.rewardId !== 'string' || !isUuidV4(row.rewardId) || typeof row.rewardTitleSnapshot !== 'string' ||
      row.rewardTitleSnapshot.length === 0 || row.rewardTitleSnapshot.trim() !== row.rewardTitleSnapshot ||
      [...row.rewardTitleSnapshot].length > 80) throw new CoinContractError('invalid');
    return { kind: 'reward', id: row.rewardId, title: row.rewardTitleSnapshot };
  }
  const parts = typeof row.scopeKey === 'string' ? row.scopeKey.split(':') : [];
  if (parts.length !== 3 || !['check', 'bonus'].includes(parts[0]) || !isUuidV4(parts[1]) || parts[2] !== row.logicalDate ||
    (row.kind === 'check' && (parts[0] !== 'check' || row.boardId !== parts[1])) ||
    (row.kind === 'run_bonus' && (parts[0] !== 'bonus' || row.runKey !== `${parts[1]}|${row.logicalDate}`)) ||
    (row.kind === 'adjustment' && row.adjustsId !== null && (typeof row.adjustsId !== 'string' || !isUuidV5(row.adjustsId)))) throw new CoinContractError('invalid');
  return { kind: parts[0] === 'check' ? 'habit' : 'stack', id: parts[1] as BoardId, title: null, status: 'missing' };
}

function withBoard(reference: CoinHistoryReference, boards: ReadonlyMap<BoardId, CoinHistoryBoard>): CoinHistoryReference {
  if (reference.kind === 'reward') return reference;
  const board = boards.get(reference.id);
  if (!board) return reference;
  if (typeof board.title !== 'string' ||
    [board.archivedAt, board.deletedAt].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new CoinContractError('invalid');
  return { ...reference, title: board.title, status: board.deletedAt !== null ? 'deleted' : board.archivedAt !== null ? 'archived' : 'active' };
}

export async function getCoinHistoryPage(deps: QueryDeps, input: CoinHistoryInput = {}): Promise<DomainResult<CoinHistoryPage>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
    Object.keys(input).some(key => key !== 'limit' && key !== 'before') ||
    (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) ||
    (input.before !== undefined && !validCursor(input.before))) return err('validation', 'Invalid coin history page.');
  const limit = input.limit ?? 50;
  return runQuery(deps, async tx => {
    const rows = await readCoinHistoryRows(tx, limit + 1, input.before);
    const selected = rows.slice(0, limit);
    const references = selected.map(referenceFor);
    const ids = [...new Set(references.flatMap(reference => reference.kind === 'reward' ? [] : [reference.id]))];
    const boards = new Map((ids.length ? await readCoinHistoryBoards(tx, ids) : []).map(board => [board.id, board]));
    const items = selected.map((row, index): CoinHistoryItem => ({
      id: row.id, kind: row.kind, delta: row.delta, logicalDate: row.logicalDate, createdAt: row.createdAt,
      reference: withBoard(references[index], boards),
      adjustment: row.kind === 'adjustment' ? row.adjustsId === null ? 'correction' : 'cancellation' : null,
    }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit ? { logicalDate: last.logicalDate, createdAt: last.createdAt, id: last.id } : null };
  });
}
