import { isValidLogicalDate } from '../calendar/logical-date';
import { assertCoinLedgerShape, canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { COIN_RECORD_BYTES, CoinContractError } from './coin-policy';
import { baselineAction, canonicalHabitAction, validateHabitAction, type HabitAction } from './habit-actions';
import { isUuidV4, isUuidV5, type CheckInId, type LogicalDate } from './ids';
import type { Hashing } from './ports';
import { guardRemoteFactHashing } from './remote-fact-hashing';

export type RemoteFactType = 'habit_action' | 'ledger_entry';
export type RemoteFactIdentity = { factType: RemoteFactType; factId: string };
export type RemoteFactCandidate = RemoteFactIdentity & { value: unknown; enqueueOnAdmission: boolean };
export type CanonicalRemoteFact =
  | { factType: 'habit_action'; value: HabitAction }
  | { factType: 'ledger_entry'; value: CoinLedgerRow };
export type PreparedRemoteFact = RemoteFactIdentity & {
  payloadDigest: string;
  payloadEncoding: 'canonical_v1' | 'rejected_json_v1';
  payload: string;
  payloadBytes: number;
  logicalDate: LogicalDate | null;
  scopeKey: string | null;
  enqueueOnAdmission: boolean;
  fact: CanonicalRemoteFact | null;
};

// these errors must escape a receipt-writing transaction before domain mapping.
export class RemoteFactAdmissionError extends Error {
  constructor(readonly reason: 'envelope' | 'capacity' | 'integrity') {
    super(`Remote fact admission ${reason}.`);
  }
}

const actionFields = ['id', 'commandId', 'boardId', 'logicalDate', 'checkInId', 'kind',
  'createdAt', 'mutationStamp', 'policyJson'];
const ledgerFields = ['id', 'kind', 'delta', 'boardId', 'checkInId', 'runKey', 'rewardId',
  'rewardTitleSnapshot', 'reversesId', 'scopeKey', 'sourceActionId', 'reconciliationKey',
  'adjustsId', 'provenanceJson', 'logicalDate', 'createdAt', 'mutationStamp', 'deletedAt'];

function snapshotJson(value: unknown): { payload: string; value: unknown; signedZero: boolean } {
  let payload: string;
  let signedZero = false;
  try {
    payload = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
        typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new RemoteFactAdmissionError('envelope');
      }
      if (Object.is(item, -0)) signedZero = true;
      return item;
    });
  } catch (cause) {
    if (cause instanceof TypeError) throw new RemoteFactAdmissionError('envelope');
    throw cause;
  }
  return { payload, value: JSON.parse(payload) as unknown, signedZero };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function selectors(factType: RemoteFactType, value: unknown) {
  const row = record(value);
  const logicalDate = typeof row?.logicalDate === 'string' && isValidLogicalDate(row.logicalDate)
    ? row.logicalDate as LogicalDate : null;
  let scopeKey: string | null = null;
  if (logicalDate !== null && row !== null) {
    if (factType === 'habit_action' && typeof row.boardId === 'string' && isUuidV4(row.boardId)) {
      scopeKey = `check:${row.boardId}:${logicalDate}`;
    } else if (factType === 'ledger_entry' && typeof row.scopeKey === 'string') {
      const parts = row.scopeKey.split(':');
      if (parts.length === 3 && ['check', 'bonus'].includes(parts[0]) &&
        isUuidV4(parts[1]) && parts[2] === logicalDate) scopeKey = row.scopeKey;
    }
  }
  return { logicalDate, scopeKey };
}

function validateShape(factType: RemoteFactType, factId: string, value: unknown): CanonicalRemoteFact | null {
  const row = record(value);
  if (row === null || row.id !== factId) return null;
  if (factType === 'habit_action') {
    if (Object.keys(row).length !== actionFields.length || actionFields.some(key => !(key in row))) return null;
    const action = row as HabitAction;
    const result = validateHabitAction(action);
    if (!result.ok && result.error.code === 'capacity') throw new RemoteFactAdmissionError('capacity');
    return result.ok ? { factType, value: action } : null;
  }
  try {
    return { factType, value: assertCoinLedgerShape(row) };
  } catch (cause) {
    if (cause instanceof CoinContractError && cause.reason === 'size') throw new RemoteFactAdmissionError('capacity');
    if (cause instanceof CoinContractError) return null;
    throw cause;
  }
}

function captureRemoteFact(candidate: RemoteFactCandidate) {
  if (!candidate) throw new RemoteFactAdmissionError('envelope');
  const { factType, factId, enqueueOnAdmission, value } = candidate;
  if ((factType !== 'habit_action' && factType !== 'ledger_entry') ||
    typeof factId !== 'string' || !(isUuidV4(factId) || isUuidV5(factId)) ||
    typeof enqueueOnAdmission !== 'boolean') throw new RemoteFactAdmissionError('envelope');
  const snapshot = snapshotJson(value);
  const fact = snapshot.signedZero ? null : validateShape(factType, factId, snapshot.value);
  return { factType, factId, enqueueOnAdmission, snapshot, fact };
}

async function finishRemoteFact(captured: ReturnType<typeof captureRemoteFact>, hashing: Hashing): Promise<PreparedRemoteFact> {
  const { factType, factId, enqueueOnAdmission, snapshot } = captured;
  const fact = await validateBaseline(captured.fact, hashing);
  const payload = fact === null ? snapshot.payload : canonicalPayload(fact);
  const payloadEncoding = fact === null ? 'rejected_json_v1' : 'canonical_v1';
  const payloadBytes = new TextEncoder().encode(payload).length;
  if (payloadBytes > COIN_RECORD_BYTES) throw new RemoteFactAdmissionError('capacity');
  const payloadDigest = await digestPayload(factType, factId, payloadEncoding, payload, hashing);
  return { factType, factId, payloadDigest,
    payloadEncoding, payload, payloadBytes, ...selectors(factType, snapshot.value), enqueueOnAdmission, fact };
}

export async function prepareRemoteFact(candidate: RemoteFactCandidate, hashing: Hashing): Promise<PreparedRemoteFact> {
  return finishRemoteFact(captureRemoteFact(candidate), hashing);
}

// capture the complete batch before awaiting any provider; hashing stays sequential.
export async function prepareRemoteFacts(candidates: readonly RemoteFactCandidate[], sourceHashing: Hashing): Promise<PreparedRemoteFact[]> {
  if (!Array.isArray(candidates)) throw new RemoteFactAdmissionError('envelope');
  const hashing = guardRemoteFactHashing(sourceHashing);
  const captured = candidates.map(captureRemoteFact);
  const prepared: PreparedRemoteFact[] = [];
  for (const item of captured) prepared.push(await finishRemoteFact(item, hashing));
  return prepared;
}

async function validateBaseline(fact: CanonicalRemoteFact | null, hashing: Hashing) {
  if (fact?.factType === 'habit_action' && fact.value.kind === 'baseline') {
    // hashing is outside shape catches: an unavailable port is never a rejected fact.
    const expected = await baselineAction({ id: fact.value.checkInId as CheckInId,
      boardId: fact.value.boardId, logicalDate: fact.value.logicalDate }, hashing);
    if (expected.id !== fact.value.id) return null;
  }
  return fact;
}

function canonicalPayload(fact: CanonicalRemoteFact) {
  return fact.factType === 'habit_action' ? canonicalHabitAction(fact.value) : canonicalCoinLedger(fact.value);
}

async function digestPayload(factType: RemoteFactType, factId: string,
  encoding: PreparedRemoteFact['payloadEncoding'], payload: string, hashing: Hashing) {
  const digestInput = encoding === 'rejected_json_v1'
    ? JSON.stringify(['habit-remote-rejected-json-v1', factType, factId, payload]) : payload;
  const digest = await hashing.sha256(new TextEncoder().encode(digestInput));
  if (digest.length !== 32) throw new Error('SHA-256 must return 32 bytes.');
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// recovery verifies stored bytes; rejected diagnostics never acquire admission authority.
export async function restorePreparedRemoteFact(input: Omit<PreparedRemoteFact, 'fact'>,
  sourceHashing: Hashing): Promise<PreparedRemoteFact> {
  if (!input) throw new RemoteFactAdmissionError('integrity');
  const { factType, factId, payloadEncoding, payload, payloadBytes, payloadDigest,
    logicalDate, scopeKey, enqueueOnAdmission } = input;
  if ((factType !== 'habit_action' && factType !== 'ledger_entry') ||
    typeof factId !== 'string' || !(isUuidV4(factId) || isUuidV5(factId)) ||
    typeof enqueueOnAdmission !== 'boolean' ||
    (payloadEncoding !== 'canonical_v1' && payloadEncoding !== 'rejected_json_v1') ||
    typeof payload !== 'string' || !Number.isSafeInteger(payloadBytes) || payloadBytes < 1 ||
    payloadBytes > COIN_RECORD_BYTES || new TextEncoder().encode(payload).length !== payloadBytes ||
    typeof payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(payloadDigest)) {
    throw new RemoteFactAdmissionError('integrity');
  }
  let value: unknown;
  try { value = JSON.parse(payload) as unknown; }
  catch { throw new RemoteFactAdmissionError('integrity'); }
  const hashing = guardRemoteFactHashing(sourceHashing);
  let fact: CanonicalRemoteFact | null = null;
  if (payloadEncoding === 'canonical_v1') {
    const fields = factType === 'habit_action' ? actionFields : ledgerFields;
    const offset = factType === 'habit_action' ? 0 : 1;
    if (!Array.isArray(value) || value.length !== fields.length + offset ||
      (offset === 1 && value[0] !== 'habit-ledger-row-v1')) throw new RemoteFactAdmissionError('integrity');
    const tuple = value;
    value = Object.fromEntries(fields.map((field, index) => [field, tuple[index + offset]]));
    try { fact = validateShape(factType, factId, value); }
    catch (cause) {
      if (cause instanceof RemoteFactAdmissionError) throw new RemoteFactAdmissionError('integrity');
      throw cause;
    }
    fact = await validateBaseline(fact, hashing);
    if (fact === null || canonicalPayload(fact) !== payload) throw new RemoteFactAdmissionError('integrity');
  } else if (JSON.stringify(value) !== payload) throw new RemoteFactAdmissionError('integrity');
  const expected = selectors(factType, value);
  if (expected.logicalDate !== logicalDate || expected.scopeKey !== scopeKey ||
    await digestPayload(factType, factId, payloadEncoding, payload, hashing) !== payloadDigest) {
    throw new RemoteFactAdmissionError('integrity');
  }
  return { factType, factId, payloadEncoding, payload, payloadBytes, payloadDigest,
    logicalDate, scopeKey, enqueueOnAdmission, fact };
}
