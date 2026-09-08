import type { Reward } from '../../domain/entities';
import type { RewardId } from '../../domain/ids';
import type { SqlExecutor } from '../database';

const COLUMNS = `id, title, cost_coins AS costCoins, symbol, accent_hex AS accentHex,
  order_key AS orderKey, archived_at AS archivedAt, created_at AS createdAt,
  updated_at AS updatedAt, mutation_stamp AS mutationStamp, deleted_at AS deletedAt`;

export async function getRewardById(tx: SqlExecutor, id: RewardId): Promise<Reward | null> {
  return tx.getFirstAsync<Reward>(`SELECT ${COLUMNS} FROM rewards WHERE id = ? AND deleted_at IS NULL`, [id]);
}

export async function listRewardRows(tx: SqlExecutor, archived: boolean): Promise<Reward[]> {
  return tx.getAllAsync<Reward>(`SELECT ${COLUMNS} FROM rewards
    WHERE deleted_at IS NULL AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
    ORDER BY order_key, id`);
}

export async function insertReward(tx: SqlExecutor, reward: Reward): Promise<void> {
  await tx.runAsync(`INSERT INTO rewards
    (id, title, cost_coins, symbol, accent_hex, order_key, archived_at, created_at, updated_at, mutation_stamp, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [reward.id, reward.title, reward.costCoins, reward.symbol,
    reward.accentHex, reward.orderKey, reward.archivedAt, reward.createdAt, reward.updatedAt, reward.mutationStamp, reward.deletedAt]);
}

export async function updateRewardRow(tx: SqlExecutor, reward: Reward): Promise<void> {
  await tx.runAsync(`UPDATE rewards SET title = ?, cost_coins = ?, symbol = ?, accent_hex = ?,
    order_key = ?, archived_at = ?, updated_at = ?, mutation_stamp = ?, deleted_at = ? WHERE id = ?`,
  [reward.title, reward.costCoins, reward.symbol, reward.accentHex, reward.orderKey, reward.archivedAt,
    reward.updatedAt, reward.mutationStamp, reward.deletedAt, reward.id]);
}
