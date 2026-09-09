import { replayBonusCoins } from './bonus-coins';
import { assertBonusEnvelope, prepareBonusActions } from './bonus-evidence';
import { prepareBonusOrdinaryValidator, validateBonusOrdinary } from './bonus-validation';
import { canonicalCoinLedger, type CoinLedgerRow } from './coin-ledger';
import { CoinContractError } from './coin-policy';
import { validateCheckOrdinary } from './coin-reconciliation';
import { prepareCoinCancellation, prepareCoinEvidence, validateCoinCorrection, type ReconciliationContext, type ValidatedCoinCorrection } from './coin-reconciliation-core';
import { coinDigest, parseCoinProvenance } from './coin-provenance';
import { orderedCoinActions, replayCheckCoins } from './coins';
import { canonicalHabitAction, type HabitAction } from './habit-actions';
import type { Hashing } from './ports';
import { guardRemoteFactHashing } from './remote-fact-hashing';
import { captureRemoteCoinScope, remoteFactKey, type RemoteCoinScopeInput } from './remote-fact-scope-inputs';
import { RemoteFactAdmissionError, type CanonicalRemoteFact } from './remote-fact-validation';

export type IntrinsicVerdict<Value = void> = { status: 'valid'; value: Value } | { status: 'pending' | 'invalid' };
type Input = Pick<RemoteCoinScopeInput, 'scope' | 'actions' | 'knownFacts'>;

async function operation<Value>(work: () => Promise<Value>): Promise<Value> {
  try { return await work(); }
  catch (cause) {
    if (cause instanceof CoinContractError) throw new RemoteFactAdmissionError('integrity');
    throw cause;
  }
}
async function classify<Value>(work: () => Promise<Value>): Promise<IntrinsicVerdict<Value>> {
  try { return { status: 'valid', value: await work() }; }
  catch (cause) {
    if (cause instanceof CoinContractError) {
      if (cause.reason === 'missing') return { status: 'pending' };
      if (cause.reason === 'invalid') return { status: 'invalid' };
      throw new RemoteFactAdmissionError('capacity');
    }
    throw cause;
  }
}

// sourcehashing is raw; callers supply complete unique authority and classify sequentially.
export async function prepareRemoteCoinIntrinsic(input: Input, sourceHashing: Hashing) {
  const captured = captureRemoteCoinScope({ ...input, acceptedRows: [], candidateRows: [] });
  const hashing = guardRemoteFactHashing(sourceHashing);
  const { scope, scopeKey, facts } = captured;
  const awardKind = scope.kind === 'check' ? 'check' : 'run_bonus';
  const actions = await operation(async () => {
    if (scope.kind === 'check') return orderedCoinActions(scope, captured.actions);
    const prepared = await prepareBonusActions(scope, captured.actions, hashing);
    assertBonusEnvelope(scope, prepared);
    return prepared;
  });
  const context: Readonly<ReconciliationContext> = Object.freeze({ scopeKey, logicalDate: scope.logicalDate, awardKind,
    replay: evidence => scope.kind === 'check' ? replayCheckCoins(scope, evidence, hashing) : replayBonusCoins(scope, evidence, hashing),
    // every correction subset creates a fresh validator through the existing wrapper.
    validateOrdinary: (evidence, rows) => scope.kind === 'check' ? validateCheckOrdinary(evidence, rows, hashing)
      : validateBonusOrdinary(scope, evidence, rows, hashing),
  });
  const knownActions = [...facts.values()].filter((fact): fact is Extract<CanonicalRemoteFact, { factType: 'habit_action' }> =>
    fact.factType === 'habit_action' && fact.value.logicalDate === scope.logicalDate).map(fact => fact.value);
  const recoveryActions = scope.kind === 'bonus' ? await operation(() => prepareBonusActions(scope, knownActions, hashing)) : knownActions;
  const validateOrdinary = scope.kind === 'bonus' ? prepareBonusOrdinaryValidator(scope, recoveryActions, hashing)
    : (rows: readonly CoinLedgerRow[]) => validateCheckOrdinary(recoveryActions, rows, hashing);

  function rowSnapshot(value: CoinLedgerRow) {
    return captureRemoteCoinScope({ scope, actions: [], acceptedRows: [], candidateRows: [value], knownFacts: [] }).candidateRows[0];
  }
  function actionCause(id: string, role: 'award' | 'removal') {
    const fact = facts.get(remoteFactKey('habit_action', id));
    if (fact === undefined) return false;
    const action = fact.value as HabitAction;
    if (action.logicalDate !== scope.logicalDate || (scope.kind === 'check' && action.boardId !== scope.boardId)) throw new CoinContractError('invalid');
    if (role === 'award' ? action.kind !== 'check' : !['uncheck', 'move_out'].includes(action.kind)) throw new CoinContractError('invalid');
    return true;
  }
  async function award(value: CoinLedgerRow): Promise<IntrinsicVerdict> {
    const row = rowSnapshot(value);
    if (row.kind !== awardKind) throw new RemoteFactAdmissionError('integrity');
    return classify(async () => {
      if (!actionCause(row.sourceActionId!, 'award')) throw new CoinContractError('missing');
      await validateOrdinary([row]);
    });
  }
  async function reversal(value: CoinLedgerRow, resolvedAward: CoinLedgerRow | undefined): Promise<IntrinsicVerdict> {
    const row = rowSnapshot(value);
    const original = resolvedAward === undefined ? undefined : [...captureRemoteCoinScope({ scope, actions: [],
      acceptedRows: [], candidateRows: [], knownFacts: [{ factType: 'ledger_entry', value: resolvedAward }] }).facts.values()][0].value as CoinLedgerRow;
    if (row.kind !== 'reversal' || (original !== undefined && original.id !== row.reversesId)) throw new RemoteFactAdmissionError('integrity');
    return classify(async () => {
      const causeKnown = actionCause(row.sourceActionId!, 'removal');
      const known = row.reversesId === row.id ? row : original ?? facts.get(remoteFactKey('ledger_entry', row.reversesId!))?.value as CoinLedgerRow | undefined;
      if (known !== undefined && (known.kind !== awardKind || known.scopeKey !== scopeKey || known.logicalDate !== scope.logicalDate)) throw new CoinContractError('invalid');
      const sourceKnown = original !== undefined && actionCause(original.sourceActionId!, 'award');
      if (!causeKnown || !sourceKnown) throw new CoinContractError('missing');
      await validateOrdinary([original!, row]);
    });
  }
  async function proofs(resolvedOrdinaryRows: readonly CoinLedgerRow[]) {
    const ordinary = captureRemoteCoinScope({ scope, actions: [], acceptedRows: resolvedOrdinaryRows,
      candidateRows: [], knownFacts: [] }).acceptedRows;
    const prepared = await operation(() => prepareCoinEvidence(actions, ordinary, hashing));
    const knownRows = new Map([...facts.values()].filter((fact): fact is Extract<CanonicalRemoteFact, { factType: 'ledger_entry' }> =>
      fact.factType === 'ledger_entry').map(fact => [fact.value.id as string, fact.value]));
    for (const row of ordinary) knownRows.set(row.id, row);
    const issuedParents = new WeakSet<ValidatedCoinCorrection>();
    async function validateParent(row: CoinLedgerRow) {
      const subsetActions: HabitAction[] = []; const subsetRows: CoinLedgerRow[] = [];
      let outsideEnvelope = false; let missing = false;
      for (const fingerprint of parseCoinProvenance(row.provenanceJson!)) {
        const included = prepared.get(fingerprint[0], fingerprint[1]);
        const fact = fingerprint[0] === 'ledger_entry' && fingerprint[1] === row.id
          ? { factType: 'ledger_entry', value: row } : included === undefined ? facts.get(remoteFactKey(fingerprint[0], fingerprint[1]))
          : { factType: fingerprint[0], value: included.value };
        if (fact === undefined) { missing = true; continue; }
        if (fact.value.logicalDate !== scope.logicalDate) throw new CoinContractError('invalid');
        if (fingerprint[0] === 'habit_action') {
          const action = fact.value as HabitAction;
          if (scope.kind === 'check' && action.boardId !== scope.boardId) throw new CoinContractError('invalid');
          subsetActions.push(action);
        } else {
          const ledger = fact.value as CoinLedgerRow;
          if (![awardKind, 'reversal'].includes(ledger.kind) || ledger.scopeKey !== scopeKey) throw new CoinContractError('invalid');
          subsetRows.push(ledger);
        }
        if (included !== undefined) {
          if (included.fingerprint[2] !== fingerprint[2]) throw new CoinContractError('invalid');
        } else {
          outsideEnvelope = true;
          const text = fingerprint[0] === 'habit_action' ? canonicalHabitAction(fact.value as HabitAction) : canonicalCoinLedger(fact.value as CoinLedgerRow);
          if (await coinDigest(text, hashing) !== fingerprint[2]) throw new CoinContractError('invalid');
        }
      }
      // direct known defects take precedence; incomplete subsets never run economic validation.
      if (missing) throw new CoinContractError('missing');
      if (outsideEnvelope) {
        // complete declared facts must prove their own cause even when g is outside current e.
        try { await context.validateOrdinary(subsetActions, subsetRows); }
        catch (cause) {
          if (cause instanceof CoinContractError && cause.reason === 'missing') throw new CoinContractError('invalid');
          throw cause;
        }
        await context.replay(subsetActions);
        const subset = await prepareCoinEvidence(subsetActions, subsetRows, hashing);
        await validateCoinCorrection(context, row, subset, knownRows, hashing);
        // a valid exact-scope proof outside final e means the caller did not supply complete e.
        throw new RemoteFactAdmissionError('integrity');
      }
      return validateCoinCorrection(context, row, prepared, knownRows, hashing);
    }

    async function correction(value: CoinLedgerRow): Promise<IntrinsicVerdict<ValidatedCoinCorrection>> {
      const row = rowSnapshot(value);
      if (row.kind !== 'adjustment' || row.adjustsId !== null) throw new RemoteFactAdmissionError('integrity');
      return classify(async () => {
        const parent = await validateParent(row);
        issuedParents.add(parent);
        return parent;
      });
    }
    async function cancellation(value: CoinLedgerRow, resolvedParent: ValidatedCoinCorrection | undefined): Promise<IntrinsicVerdict> {
      const row = rowSnapshot(value);
      if (row.kind !== 'adjustment' || row.adjustsId === null || (resolvedParent !== undefined &&
        (!issuedParents.has(resolvedParent) || resolvedParent.row.id !== row.adjustsId))) throw new RemoteFactAdmissionError('integrity');
      return classify(async () => {
        const known = row.adjustsId === row.id ? row : resolvedParent?.row ?? knownRows.get(row.adjustsId!);
        if (known !== undefined && (known.kind !== 'adjustment' || known.adjustsId !== null || known.scopeKey !== scopeKey)) {
          throw new CoinContractError('invalid');
        }
        if (resolvedParent === undefined) throw new CoinContractError('missing');
        const expected = await prepareCoinCancellation(resolvedParent, hashing);
        if (expected === null) throw new CoinContractError('missing');
        if (canonicalCoinLedger(expected) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
      });
    }
    return Object.freeze({ ordinaryEvidenceCount: prepared.facts.length, correction, cancellation });
  }
  return Object.freeze({ context, award, reversal, proofs });
}
