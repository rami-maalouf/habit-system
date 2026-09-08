import type { Reward } from './entities';
import type { RewardId } from './ids';
import { isUuidV4 } from './ids';
import { CoinContractError } from './coin-policy';
import type { QueryDeps } from './queries';
import { runQuery } from './queries';
import type { DomainResult } from './result';
import { err, ok } from './result';
import type { SqlExecutor } from '../persistence/database';
import { readCoinTotals } from '../persistence/repositories/coin-history';
import { getRewardById, listRewardRows } from '../persistence/repositories/rewards';

export type ListRewardsInput = { archived?: boolean };
export type RewardClaimPreview = { reward: Reward; balance: number; balanceAfterClaim: number | null };

async function readReward(tx: SqlExecutor, rewardId: RewardId): Promise<DomainResult<Reward>> {
  if (typeof rewardId !== 'string' || !isUuidV4(rewardId)) return err('validation', 'Choose a valid reward.');
  const reward = await getRewardById(tx, rewardId);
  return reward ? ok(reward) : err('not_found', 'This reward no longer exists.');
}

async function rewardQuery<T>(deps: QueryDeps, work: (tx: SqlExecutor) => Promise<DomainResult<T>>): Promise<DomainResult<T>> {
  const result = await runQuery(deps, work);
  return result.ok ? result.value : result;
}

export function listRewards(deps: QueryDeps, input: ListRewardsInput = {}): Promise<DomainResult<Reward[]>> {
  return rewardQuery(deps, async (tx) => {
    if (input.archived !== undefined && typeof input.archived !== 'boolean') return err('validation', 'Choose active or archived rewards.');
    return ok(await listRewardRows(tx, input.archived ?? false));
  });
}

export function getReward(deps: QueryDeps, rewardId: RewardId): Promise<DomainResult<Reward>> {
  return rewardQuery(deps, (tx) => readReward(tx, rewardId));
}

export function getRewardClaimPreview(deps: QueryDeps, rewardId: RewardId): Promise<DomainResult<RewardClaimPreview>> {
  return rewardQuery(deps, async (tx) => {
    const result = await readReward(tx, rewardId);
    if (!result.ok) return result;
    const reward = result.value;
    if (reward.archivedAt !== null) return err('archived', 'Restore this reward before claiming it.');
    try {
      const { balance } = await readCoinTotals(tx);
      return ok({ reward, balance, balanceAfterClaim: balance < reward.costCoins ? null : balance - reward.costCoins });
    } catch (cause) {
      if (cause instanceof CoinContractError) return err('capacity', 'The coin totals are too large to use safely.');
      throw cause;
    }
  });
}
