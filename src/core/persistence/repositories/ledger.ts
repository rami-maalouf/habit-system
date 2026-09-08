import { assertCoinLedgerShape, canonicalCoinLedger } from '../../domain/coin-ledger';
import type { CoinLedgerRow } from '../../domain/coin-ledger';
import type { LedgerEntryId } from '../../domain/ids';
import type { SqlExecutor } from '../database';

type LedgerRecord = {
  id: LedgerEntryId; kind: CoinLedgerRow['kind']; delta: number;
  board_id: CoinLedgerRow['boardId']; check_in_id: CoinLedgerRow['checkInId'];
  run_key: string | null; reward_id: CoinLedgerRow['rewardId'];
  reward_title_snapshot: string | null; reverses_id: LedgerEntryId | null;
  scope_key: string | null; source_action_id: CoinLedgerRow['sourceActionId'];
  reconciliation_key: string | null; adjusts_id: LedgerEntryId | null;
  provenance_json: string | null; logical_date: CoinLedgerRow['logicalDate'];
  created_at: number; mutation_stamp: string; deleted_at: null;
};

function fromRow(row: LedgerRecord): CoinLedgerRow {
  return assertCoinLedgerShape({
    id: row.id, kind: row.kind, delta: row.delta, boardId: row.board_id,
    checkInId: row.check_in_id, runKey: row.run_key, rewardId: row.reward_id,
    rewardTitleSnapshot: row.reward_title_snapshot, reversesId: row.reverses_id,
    scopeKey: row.scope_key, sourceActionId: row.source_action_id,
    reconciliationKey: row.reconciliation_key, adjustsId: row.adjusts_id,
    provenanceJson: row.provenance_json, logicalDate: row.logical_date,
    createdAt: row.created_at, mutationStamp: row.mutation_stamp, deletedAt: row.deleted_at,
  });
}

export async function getLedgerEntry(tx: SqlExecutor, id: LedgerEntryId): Promise<CoinLedgerRow | null> {
  const row = await tx.getFirstAsync<LedgerRecord>('SELECT * FROM coin_ledger WHERE id = ?', [id]);
  return row === null ? null : fromRow(row);
}

// callers validate economic causes and append the outbox within their transaction.
// this boundary enforces intrinsic shape and immutable payload identity only.
export async function appendLedgerEntry(tx: SqlExecutor, entry: CoinLedgerRow): Promise<boolean> {
  const row = assertCoinLedgerShape(entry);
  const existing = await getLedgerEntry(tx, row.id);
  if (existing !== null) {
    if (canonicalCoinLedger(existing) !== canonicalCoinLedger(row)) {
      throw new Error('Immutable ledger entry conflicts with its saved payload.');
    }
    return false;
  }
  await tx.runAsync(`INSERT INTO coin_ledger
    (id, kind, delta, board_id, check_in_id, run_key, reward_id, reward_title_snapshot,
      reverses_id, scope_key, source_action_id, reconciliation_key, adjusts_id, provenance_json,
      logical_date, created_at, mutation_stamp, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [row.id, row.kind, row.delta, row.boardId, row.checkInId, row.runKey, row.rewardId,
    row.rewardTitleSnapshot, row.reversesId, row.scopeKey, row.sourceActionId,
    row.reconciliationKey, row.adjustsId, row.provenanceJson, row.logicalDate,
    row.createdAt, row.mutationStamp, row.deletedAt]);
  return true;
}

export async function listLedgerEntriesForScope(tx: SqlExecutor, scopeKey: string): Promise<CoinLedgerRow[]> {
  const rows = await tx.getAllAsync<LedgerRecord>(
    'SELECT * FROM coin_ledger WHERE scope_key = ? ORDER BY mutation_stamp, id', [scopeKey],
  );
  return rows.map(fromRow);
}
