import { uuidV5 } from './deterministic-ids';
import { isValidLogicalDate } from '../calendar/logical-date';
import { COIN_RECORD_BYTES, CoinContractError } from './coin-policy';
import { parseCoinProvenance } from './coin-provenance';
import { isUuidV4, isUuidV5 } from './ids';
import type { BoardId, CheckInId, HabitActionId, LedgerEntryId, LogicalDate, RewardId } from './ids';
import type { HabitAction } from './habit-actions';
import type { Hashing } from './ports';

export type CoinLedgerRow = {
  id: LedgerEntryId; kind: 'check' | 'run_bonus' | 'claim' | 'reversal' | 'adjustment'; delta: number;
  boardId: BoardId | null; checkInId: CheckInId | null; runKey: string | null;
  rewardId: RewardId | null; rewardTitleSnapshot: string | null; reversesId: LedgerEntryId | null;
  scopeKey: string | null; sourceActionId: HabitActionId | null; reconciliationKey: string | null;
  adjustsId: LedgerEntryId | null; provenanceJson: string | null; logicalDate: LogicalDate;
  createdAt: number; mutationStamp: string; deletedAt: null;
};

const roleFields = ['boardId', 'checkInId', 'runKey', 'rewardId', 'rewardTitleSnapshot', 'reversesId',
  'scopeKey', 'sourceActionId', 'reconciliationKey', 'adjustsId', 'provenanceJson'] as const;
const roles: Record<CoinLedgerRow['kind'], readonly typeof roleFields[number][]> = {
  check: ['boardId', 'checkInId', 'scopeKey', 'sourceActionId'],
  run_bonus: ['runKey', 'scopeKey', 'sourceActionId'], claim: ['rewardId', 'rewardTitleSnapshot'],
  reversal: ['reversesId', 'scopeKey', 'sourceActionId'],
  adjustment: ['scopeKey', 'reconciliationKey', 'provenanceJson', 'adjustsId'],
};

export function assertCoinLedgerShape(input: unknown): CoinLedgerRow {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CoinContractError('invalid');
  const row = input as CoinLedgerRow;
  const keys = ['id', 'kind', 'delta', ...roleFields, 'logicalDate', 'createdAt', 'mutationStamp', 'deletedAt'];
  if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)) ||
    typeof row.kind !== 'string' || !Object.hasOwn(roles, row.kind) || typeof row.id !== 'string' ||
    !(row.kind === 'claim' ? isUuidV4(row.id) : isUuidV5(row.id)) || !Number.isSafeInteger(row.delta) || row.delta === 0 ||
    !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || Object.is(row.createdAt, -0) ||
    typeof row.logicalDate !== 'string' || !isValidLogicalDate(row.logicalDate) || row.deletedAt !== null ||
    typeof row.mutationStamp !== 'string' || !/^\d{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$/.test(row.mutationStamp)) throw new CoinContractError('invalid');
  for (const field of roleFields) {
    const optional = row.kind === 'adjustment' && field === 'adjustsId';
    if (roles[row.kind].includes(field) ? (!optional && row[field] === null) || (row[field] !== null && typeof row[field] !== 'string') : row[field] !== null) throw new CoinContractError('invalid');
  }
  if ((row.kind === 'check' || row.kind === 'run_bonus') ? row.delta !== 1 : row.kind !== 'adjustment' && row.delta >= 0) throw new CoinContractError('invalid');
  for (const id of [row.boardId, row.checkInId, row.rewardId, row.sourceActionId]) if (id !== null && !isUuidV4(id)) throw new CoinContractError('invalid');
  for (const id of [row.reversesId, row.adjustsId]) if (id !== null && !isUuidV5(id)) throw new CoinContractError('invalid');
  if (row.scopeKey !== null) {
    const parts = row.scopeKey.split(':');
    if (parts.length !== 3 || !['check', 'bonus'].includes(parts[0]) || !isUuidV4(parts[1]) || parts[2] !== row.logicalDate ||
      (row.kind === 'check' && row.scopeKey !== `check:${row.boardId}:${row.logicalDate}`) ||
      (row.kind === 'run_bonus' && (parts[0] !== 'bonus' || row.runKey !== `${parts[1]}|${row.logicalDate}`))) throw new CoinContractError('invalid');
  }
  if (row.rewardTitleSnapshot !== null && (row.rewardTitleSnapshot.trim() !== row.rewardTitleSnapshot ||
    row.rewardTitleSnapshot.length === 0 || [...row.rewardTitleSnapshot].length > 80 || /[\uD800-\uDFFF]/u.test(row.rewardTitleSnapshot))) throw new CoinContractError('invalid');
  if (row.reconciliationKey !== null && !/^[0-9a-f]{64}$/.test(row.reconciliationKey)) throw new CoinContractError('invalid');
  if (row.provenanceJson !== null) parseCoinProvenance(row.provenanceJson);
  if (new TextEncoder().encode(canonicalCoinLedger(row)).length > COIN_RECORD_BYTES) throw new CoinContractError('size');
  return row;
}

export function canonicalCoinLedger(row: CoinLedgerRow): string {
  return JSON.stringify(['habit-ledger-row-v1', row.id, row.kind, row.delta, row.boardId, row.checkInId,
    row.runKey, row.rewardId, row.rewardTitleSnapshot, row.reversesId, row.scopeKey, row.sourceActionId,
    row.reconciliationKey, row.adjustsId, row.provenanceJson, row.logicalDate, row.createdAt, row.mutationStamp, row.deletedAt]);
}

export function coinLedgerTotals(rows: readonly CoinLedgerRow[]): { earned: number; spent: number; balance: number } {
  let earned = 0;
  let spent = 0;
  for (const input of rows) {
    const row = assertCoinLedgerShape(input);
    if (row.delta > 0) earned += row.delta; else spent -= row.delta;
    if (!Number.isSafeInteger(earned) || !Number.isSafeInteger(spent)) throw new CoinContractError('invalid');
  }
  return { earned, spent, balance: earned - spent };
}

export async function checkCoinRow(action: HabitAction, hashing: Hashing, award?: CoinLedgerRow): Promise<CoinLedgerRow> {
  const scopeKey = `check:${action.boardId}:${action.logicalDate}`;
  const kind = award ? 'reversal' : 'check';
  const name = award ? ['habit-ledger-v1', kind, award.id, action.id] : ['habit-ledger-v1', kind, scopeKey, action.id];
  return assertCoinLedgerShape({ id: await uuidV5(JSON.stringify(name), hashing) as LedgerEntryId, kind, delta: award ? -award.delta : 1,
    boardId: award ? null : action.boardId, checkInId: award ? null : action.checkInId,
    runKey: null, rewardId: null, rewardTitleSnapshot: null, reversesId: award?.id ?? null,
    scopeKey, sourceActionId: action.id, reconciliationKey: null, adjustsId: null, provenanceJson: null,
    logicalDate: action.logicalDate, createdAt: action.createdAt, mutationStamp: action.mutationStamp, deletedAt: null });
}
