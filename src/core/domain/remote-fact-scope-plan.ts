import { canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { COIN_PROOF_FACTS, CoinContractError } from './coin-policy';
import { reconcileCoinEvidence, type ValidatedCoinCorrection } from './coin-reconciliation-core';
import type { LedgerEntryId } from './ids';
import type { Hashing } from './ports';
import { guardRemoteFactHashing } from './remote-fact-hashing';
import { prepareRemoteCoinIntrinsic, type IntrinsicVerdict } from './remote-fact-intrinsic';
import { captureRemoteCoinScope, type RemoteCoinScopeInput } from './remote-fact-scope-inputs';
import { RemoteFactAdmissionError } from './remote-fact-validation';

export type { RemoteCoinScope, RemoteCoinScopeInput } from './remote-fact-scope-inputs';
export type RemoteCoinScopePlan = {
  capacity: 'fits' | 'blocked';
  ordinaryEvidenceCount: number;
  generatedRows: CoinLedgerRow[];
  candidateResults: { id: LedgerEntryId; status: 'valid' | 'pending' | 'invalid' }[];
};

// valid here is intrinsic scope validity, never cross-scope permission to persist a fact.
export async function planRemoteCoinScope(input: RemoteCoinScopeInput, sourceHashing: Hashing): Promise<RemoteCoinScopePlan> {
  const captured = captureRemoteCoinScope(input);
  const hashing = guardRemoteFactHashing(sourceHashing);
  // both boundaries capture raw provider methods before any await; neither wraps the other's guard.
  const intrinsic = await prepareRemoteCoinIntrinsic({ scope: captured.scope, actions: captured.actions,
    knownFacts: [...captured.facts.values()] }, sourceHashing);
  const { acceptedRows, candidateRows, actions } = captured;
  const { context } = intrinsic;
  async function operation<Value>(work: () => Promise<Value>): Promise<Value> {
    try { return await work(); }
    catch (cause) {
      if (cause instanceof CoinContractError) throw new RemoteFactAdmissionError(cause.reason === 'size' ? 'capacity' : 'integrity');
      throw cause;
    }
  }
  function requireAccepted<Value>(verdict: IntrinsicVerdict<Value>): Value {
    if (verdict.status !== 'valid') throw new RemoteFactAdmissionError('integrity');
    return verdict.value;
  }
  const accepted = new Map(acceptedRows.map(row => [row.id, row]));
  const ordinary = new Map<string, CoinLedgerRow>();
  function addOrdinary(row: CoinLedgerRow) {
    const old = ordinary.get(row.id);
    if (old !== undefined && canonicalCoinLedger(old) !== canonicalCoinLedger(row)) throw new RemoteFactAdmissionError('integrity');
    ordinary.set(row.id, row);
  }
  const acceptedOrdinary = acceptedRows.filter(row => row.kind !== 'adjustment');
  await operation(() => context.validateOrdinary(actions, acceptedOrdinary));
  for (const row of acceptedOrdinary) addOrdinary(row);
  // current action-only outputs can unlock supplied reversals; no speculative prior plan survives.
  const replay = await operation(() => context.replay(actions));
  for (const row of replay.ordinaryRows) addOrdinary(row);
  const decisions = new Map<LedgerEntryId, RemoteCoinScopePlan['candidateResults'][number]>();
  function note<Value>(row: CoinLedgerRow, verdict: IntrinsicVerdict<Value>) {
    decisions.set(row.id, { id: row.id, status: verdict.status });
    return verdict;
  }
  for (const row of candidateRows.filter(row => row.kind === context.awardKind)) {
    if (note(row, await intrinsic.award(row)).status === 'valid') addOrdinary(row);
  }
  for (const row of candidateRows.filter(row => row.kind === 'reversal')) {
    if (note(row, await intrinsic.reversal(row, ordinary.get(row.reversesId!))).status === 'valid') addOrdinary(row);
  }
  const proofs = await intrinsic.proofs([...ordinary.values()]);
  const parents = new Map<string, ValidatedCoinCorrection>();
  for (const row of acceptedRows.filter(row => row.kind === 'adjustment' && row.adjustsId === null)) {
    parents.set(row.id, requireAccepted(await proofs.correction(row)));
  }
  for (const row of candidateRows.filter(row => row.kind === 'adjustment' && row.adjustsId === null)) {
    const verdict = note(row, await proofs.correction(row));
    if (verdict.status === 'valid') parents.set(row.id, verdict.value);
  }
  for (const row of acceptedRows.filter(row => row.kind === 'adjustment' && row.adjustsId !== null)) {
    requireAccepted(await proofs.cancellation(row, parents.get(row.adjustsId!)));
  }
  for (const row of candidateRows.filter(row => row.kind === 'adjustment' && row.adjustsId !== null)) {
    note(row, await proofs.cancellation(row, parents.get(row.adjustsId!)));
  }
  const candidateResults = candidateRows.map(row => decisions.get(row.id)!);
  const { ordinaryEvidenceCount } = proofs;
  if (ordinaryEvidenceCount > COIN_PROOF_FACTS) return { capacity: 'blocked', ordinaryEvidenceCount, generatedRows: [], candidateResults };
  const validRows = new Map(accepted);
  for (const row of candidateRows) if (decisions.get(row.id)!.status === 'valid') validRows.set(row.id, row);
  const generatedRows: CoinLedgerRow[] = [];
  for (const row of ordinary.values()) if (!validRows.has(row.id)) { validRows.set(row.id, row); generatedRows.push(row); }
  const final = await operation(() => reconcileCoinEvidence(context, actions, [...validRows.values()], hashing));
  return { capacity: 'fits', ordinaryEvidenceCount, generatedRows: [...generatedRows, ...final.appendedRows], candidateResults };
}
