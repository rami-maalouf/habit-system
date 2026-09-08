import { assertCoinLedgerShape, type CoinLedgerRow } from './coin-ledger';
import { canonicalCoinPolicy, type CoinPolicy } from './coin-policy';
import { coinDigest } from './coin-provenance';
import { uuidV5 } from './deterministic-ids';
import type { HabitAction } from './habit-actions';
import type { BoardId, LogicalDate } from './ids';
import type { Hashing } from './ports';

export type BonusCoinScope = { rootId: BoardId; logicalDate: LogicalDate };

export async function bonusPolicyFingerprint(policy: CoinPolicy, hashing: Pick<Hashing, 'sha256'>): Promise<string> {
  canonicalCoinPolicy(policy);
  return coinDigest(JSON.stringify(['habit-bonus-policy-v1', policy.rootId, policy.requiredBoardIds,
    policy.bonusClosesAtUtc, policy.bonusEnabled]), hashing);
}

// callers validate the genuine source and selected policy before constructing a row.
export async function bonusAwardRow(scope: BonusCoinScope, source: HabitAction, policy: CoinPolicy, hashing: Hashing): Promise<CoinLedgerRow> {
  const scopeKey = `bonus:${scope.rootId}:${scope.logicalDate}`;
  const fingerprint = await bonusPolicyFingerprint(policy, hashing);
  return assertCoinLedgerShape({
    id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'run_bonus', scopeKey, source.id, fingerprint]), hashing),
    kind: 'run_bonus', delta: 1, boardId: null, checkInId: null, runKey: `${scope.rootId}|${scope.logicalDate}`,
    rewardId: null, rewardTitleSnapshot: null, reversesId: null, scopeKey, sourceActionId: source.id,
    reconciliationKey: null, adjustsId: null, provenanceJson: null, logicalDate: scope.logicalDate,
    createdAt: source.createdAt, mutationStamp: source.mutationStamp, deletedAt: null,
  });
}

export async function bonusReversalRow(removal: HabitAction, award: CoinLedgerRow, hashing: Hashing): Promise<CoinLedgerRow> {
  return assertCoinLedgerShape({ ...award,
    id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'reversal', award.id, removal.id]), hashing),
    kind: 'reversal', delta: -award.delta, runKey: null, reversesId: award.id,
    sourceActionId: removal.id, createdAt: removal.createdAt, mutationStamp: removal.mutationStamp,
  });
}
