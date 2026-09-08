import { currentLogicalDate } from '../calendar/logical-date';
import { readCoinTotals } from '../persistence/repositories/coin-history';
import { getRewardById, insertReward, listRewardRows, updateRewardRow } from '../persistence/repositories/rewards';
import { appendOutbox } from '../persistence/repositories/support';
import { CoinContractError } from './coin-policy';
import { appendLocalLedgerEntry } from './coin-settlement';
import type { CommandContext, CommandDeps } from './command-context';
import { runCommand } from './command-context';
import type { Reward } from './entities';
import type { CommandId, LedgerEntryId, LogicalDate, RewardId } from './ids';
import { isUuidV4 } from './ids';
import type { DomainResult } from './result';
import { err, ok } from './result';
import { rewardOrderKeys } from './reward-order';
import type { RewardFields } from './reward-validation';
import { validateRewardFields } from './reward-validation';

export type { RewardFields } from './reward-validation';
export type CreateRewardInput = RewardFields & { commandId: CommandId };
export type RewardTargetInput = { commandId: CommandId; rewardId: RewardId };
export type UpdateRewardInput = RewardFields & RewardTargetInput & { expectedMutationStamp: string };
export type ReorderRewardInput = RewardTargetInput & { previousRewardId: RewardId | null; nextRewardId: RewardId | null };
export type ClaimRewardInput = RewardTargetInput & { expectedMutationStamp: string };
export type ClaimRewardResult = {
  ledgerEntryId: LedgerEntryId; rewardId: RewardId; titleSnapshot: string;
  costCoins: number; logicalDate: LogicalDate; balance: number;
};

function runForReward<T>(
  deps: CommandDeps, input: RewardTargetInput, allowArchived: boolean,
  work: (context: CommandContext, reward: Reward) => Promise<DomainResult<T>>,
): Promise<DomainResult<T>> {
  return runCommand(deps, input.commandId, async (context) => {
    if (typeof input.rewardId !== 'string' || !isUuidV4(input.rewardId)) return err('validation', 'Choose a valid reward.');
    const reward = await getRewardById(context.tx, input.rewardId);
    if (!reward) return err('not_found', 'This reward no longer exists.');
    if (!allowArchived && reward.archivedAt !== null) return err('archived', 'Restore this reward before using it.');
    return work(context, reward);
  });
}

async function saveReward(context: CommandContext, reward: Reward): Promise<void> {
  await updateRewardRow(context.tx, reward);
  await appendOutbox(context.tx, 'reward', reward.id, reward.mutationStamp, context.now);
}

// new, restored and reordered rewards share bounded key allocation and atomic rebalance.
async function saveOrder(
  context: CommandContext, ordered: Reward[], index: number, inserted: boolean,
): Promise<void> {
  const keys = rewardOrderKeys(ordered, index);
  const mutationStamp = context.stamp();
  for (const [position, reward] of ordered.entries()) {
    const orderKey = keys.get(reward.id);
    if (orderKey === undefined || (position !== index && orderKey === reward.orderKey)) continue;
    const saved = { ...reward, orderKey, updatedAt: context.now, mutationStamp };
    if (inserted && position === index) {
      await insertReward(context.tx, saved);
      await appendOutbox(context.tx, 'reward', saved.id, mutationStamp, context.now);
    } else await saveReward(context, saved);
  }
}

export function createReward(deps: CommandDeps, input: CreateRewardInput): Promise<DomainResult<{ rewardId: RewardId }>> {
  return runCommand(deps, input.commandId, async (context) => {
    const fields = validateRewardFields(input);
    if (!fields.ok) return fields;
    const ordered = await listRewardRows(context.tx, false);
    const reward: Reward = { ...fields.value, id: deps.ids.uuid() as RewardId, orderKey: '',
      archivedAt: null, createdAt: context.now, updatedAt: context.now, mutationStamp: '', deletedAt: null };
    ordered.push(reward);
    await saveOrder(context, ordered, ordered.length - 1, true);
    return ok({ rewardId: reward.id });
  });
}

export function updateReward(deps: CommandDeps, input: UpdateRewardInput): Promise<DomainResult<void>> {
  return runForReward(deps, input, false, async (context, reward) => {
    if (input.expectedMutationStamp !== reward.mutationStamp) return err('conflict', 'This reward changed. Reopen it and try again.');
    const fields = validateRewardFields(input);
    if (!fields.ok) return fields;
    if (reward.title === fields.value.title && reward.costCoins === fields.value.costCoins &&
      reward.symbol === fields.value.symbol && reward.accentHex === fields.value.accentHex) return ok(undefined);
    await saveReward(context, { ...reward, ...fields.value, updatedAt: context.now, mutationStamp: context.stamp() });
    return ok(undefined);
  });
}

export function reorderReward(deps: CommandDeps, input: ReorderRewardInput): Promise<DomainResult<void>> {
  return runForReward(deps, input, false, async (context, reward) => {
    for (const id of [input.previousRewardId, input.nextRewardId]) {
      if (id !== null && (typeof id !== 'string' || !isUuidV4(id) || id === reward.id)) return err('validation', 'Choose different rewards as neighbors.');
    }
    if (input.previousRewardId !== null && input.previousRewardId === input.nextRewardId) return err('validation', 'Choose different rewards as neighbors.');
    const rows = await listRewardRows(context.tx, false);
    const remaining = rows.filter((row) => row.id !== reward.id);
    const previousIndex = input.previousRewardId === null ? -1 : remaining.findIndex((row) => row.id === input.previousRewardId);
    const index = previousIndex + 1;
    if ((input.previousRewardId !== null && previousIndex < 0) || (remaining[index]?.id ?? null) !== input.nextRewardId) {
      return err('conflict', 'The reward order changed. Refresh it and try again.');
    }
    if (rows[index].id === reward.id) return ok(undefined);
    remaining.splice(index, 0, reward);
    await saveOrder(context, remaining, index, false);
    return ok(undefined);
  });
}

export function archiveReward(deps: CommandDeps, input: RewardTargetInput): Promise<DomainResult<void>> {
  return runForReward(deps, input, false, async (context, reward) => {
    await saveReward(context, { ...reward, archivedAt: context.now, updatedAt: context.now, mutationStamp: context.stamp() });
    return ok(undefined);
  });
}

export function restoreReward(deps: CommandDeps, input: RewardTargetInput): Promise<DomainResult<void>> {
  return runForReward(deps, input, true, async (context, reward) => {
    if (reward.archivedAt === null) return err('validation', 'This reward is already active.');
    const rows = await listRewardRows(context.tx, false);
    rows.push({ ...reward, archivedAt: null });
    await saveOrder(context, rows, rows.length - 1, false);
    return ok(undefined);
  });
}

export function deleteReward(deps: CommandDeps, input: RewardTargetInput): Promise<DomainResult<void>> {
  return runForReward(deps, input, true, async (context, reward) => {
    await saveReward(context, { ...reward, deletedAt: context.now, updatedAt: context.now, mutationStamp: context.stamp() });
    return ok(undefined);
  });
}

export function claimReward(deps: CommandDeps, input: ClaimRewardInput): Promise<DomainResult<ClaimRewardResult>> {
  return runForReward(deps, input, false, async (context, reward) => {
    if (input.expectedMutationStamp !== reward.mutationStamp) return err('conflict', 'This reward changed. Review it before claiming.');
    let balance: number;
    try {
      balance = (await readCoinTotals(context.tx)).balance;
    } catch (cause) {
      if (cause instanceof CoinContractError) return err('capacity', 'The coin totals are too large to use safely.');
      throw cause;
    }
    if (balance < reward.costCoins) return err('validation', 'There are not enough coins to claim this reward.');
    const logicalDate = currentLogicalDate(context.now, context.timeZoneId, 0);
    const ledgerEntryId = deps.ids.uuid() as LedgerEntryId;
    await appendLocalLedgerEntry(context.tx, { id: ledgerEntryId, kind: 'claim', delta: -reward.costCoins,
      boardId: null, checkInId: null, runKey: null, rewardId: reward.id, rewardTitleSnapshot: reward.title,
      reversesId: null, scopeKey: null, sourceActionId: null, reconciliationKey: null, adjustsId: null,
      provenanceJson: null, logicalDate, createdAt: context.now, mutationStamp: context.stamp(), deletedAt: null }, context.now);
    return ok({ ledgerEntryId, rewardId: reward.id, titleSnapshot: reward.title, costCoins: reward.costCoins,
      logicalDate, balance: balance - reward.costCoins });
  });
}
