import { assertCoinLedgerShape, canonicalCoinLedger, checkCoinRow, coinLedgerTotals } from './coin-ledger';
import type { CoinLedgerRow } from './coin-ledger';
import { CoinContractError, parseCoinPolicy } from './coin-policy';
import { canonicalCoinProvenance, coinDigest, compareCoinTuple, parseCoinProvenance } from './coin-provenance';
import type { CoinFingerprint } from './coin-provenance';
import { orderedCoinActions, replayCheckCoins } from './coins';
import type { CheckCoinScope } from './coins';
import { uuidV5 } from './deterministic-ids';
import { canonicalHabitAction } from './habit-actions';
import type { HabitAction } from './habit-actions';
import type { LedgerEntryId } from './ids';
import type { Hashing } from './ports';

async function validateOrdinary(actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], hashing: Hashing) {
  const causes = new Map(actions.map((action) => [action.id, action]));
  const awards = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const cause = causes.get(row.sourceActionId!);
    if (!cause) throw new CoinContractError('missing');
    let expected: CoinLedgerRow;
    if (row.kind === 'check') {
      if (cause.kind !== 'check' || cause.policyJson === null || !parseCoinPolicy(cause.policyJson).earnsCoins) throw new CoinContractError('invalid');
      expected = await checkCoinRow(cause, hashing);
    } else {
      const award = awards.get(row.reversesId!);
      if (!award) throw new CoinContractError('missing');
      const source = causes.get(award.sourceActionId!);
      if (!source) throw new CoinContractError('missing');
      if (award.kind !== 'check' || !['uncheck', 'move_out'].includes(cause.kind) ||
        (cause.checkInId !== null && cause.checkInId !== award.checkInId) || source.policyJson === null ||
        cause.createdAt >= parseCoinPolicy(source.policyJson).checkClosesAtUtc ||
        compareCoinTuple([cause.mutationStamp, cause.id], [source.mutationStamp, source.id]) <= 0) throw new CoinContractError('invalid');
      expected = await checkCoinRow(cause, hashing, award);
    }
    if (canonicalCoinLedger(row) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  }
}

type Fact = { fingerprint: CoinFingerprint; value: HabitAction | CoinLedgerRow };
async function evidence(actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], hashing: Hashing): Promise<Fact[]> {
  const facts: Fact[] = [];
  for (const action of actions) facts.push({ fingerprint: ['habit_action', action.id, await coinDigest(canonicalHabitAction(action), hashing)], value: action });
  for (const row of rows) facts.push({ fingerprint: ['ledger_entry', row.id, await coinDigest(canonicalCoinLedger(row), hashing)], value: row });
  return facts.sort((a, b) => compareCoinTuple(a.fingerprint, b.fingerprint));
}

async function correction(scope: CheckCoinScope, actions: readonly HabitAction[], rows: readonly CoinLedgerRow[], facts: readonly Fact[], hashing: Hashing) {
  const replay = await replayCheckCoins(scope, actions, hashing);
  const saved = new Map(rows.map((row) => [row.id, canonicalCoinLedger(row)]));
  for (const expected of replay.ordinaryRows) if (saved.get(expected.id) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  const delta = replay.target - coinLedgerTotals(rows).balance;
  if (delta === 0) return null;
  const provenanceJson = canonicalCoinProvenance(facts.map((fact) => fact.fingerprint));
  const reconciliationKey = await coinDigest(provenanceJson, hashing);
  const last = [...facts].sort((a, b) => compareCoinTuple([a.value.mutationStamp, a.value.id, a.fingerprint[0]],
    [b.value.mutationStamp, b.value.id, b.fingerprint[0]]))[facts.length - 1].value;
  const scopeKey = replay.scopeKey;
  return assertCoinLedgerShape({ id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'adjustment', scopeKey, reconciliationKey]), hashing),
    kind: 'adjustment', delta, boardId: null, checkInId: null, runKey: null, rewardId: null, rewardTitleSnapshot: null,
    reversesId: null, scopeKey, sourceActionId: null, reconciliationKey, adjustsId: null, provenanceJson,
    logicalDate: scope.logicalDate, createdAt: last.createdAt, mutationStamp: last.mutationStamp, deletedAt: null });
}

export async function reconcileCheckCoins(scope: CheckCoinScope, inputActions: readonly HabitAction[], inputRows: readonly CoinLedgerRow[], hashing: Hashing) {
  const actions = orderedCoinActions(scope, inputActions);
  const replay = await replayCheckCoins(scope, actions, hashing);
  const rows = new Map<LedgerEntryId, CoinLedgerRow>();
  const appendedRows: CoinLedgerRow[] = [];
  for (const input of inputRows) {
    const row = assertCoinLedgerShape(input);
    if (row.scopeKey !== replay.scopeKey || !['check', 'reversal', 'adjustment'].includes(row.kind)) throw new CoinContractError('invalid');
    const prior = rows.get(row.id);
    if (prior && canonicalCoinLedger(prior) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
    rows.set(row.id, row);
  }
  function append(row: CoinLedgerRow) { if (!rows.has(row.id)) { rows.set(row.id, row); appendedRows.push(row); } }
  await validateOrdinary(actions, [...rows.values()].filter((row) => row.kind !== 'adjustment'), hashing);
  for (const row of replay.ordinaryRows) append(row);
  const ordinary = [...rows.values()].filter((row) => row.kind !== 'adjustment');
  const facts = await evidence(actions, ordinary, hashing);
  const available = new Map(facts.map((fact) => [JSON.stringify(fact.fingerprint.slice(0, 2)), fact]));
  for (const row of rows.values()) {
    if (row.kind !== 'adjustment' || row.adjustsId !== null) continue;
    const subset: Fact[] = [];
    for (const fingerprint of parseCoinProvenance(row.provenanceJson!)) {
      const fact = available.get(JSON.stringify(fingerprint.slice(0, 2)));
      if (!fact) throw new CoinContractError('missing');
      if (compareCoinTuple(fingerprint, fact.fingerprint) !== 0) throw new CoinContractError('invalid');
      subset.push(fact);
    }
    const subsetActions = subset.filter((fact) => fact.fingerprint[0] === 'habit_action').map((fact) => fact.value as HabitAction);
    const subsetRows = subset.filter((fact) => fact.fingerprint[0] === 'ledger_entry').map((fact) => fact.value as CoinLedgerRow);
    try { await validateOrdinary(subsetActions, subsetRows, hashing); } catch { throw new CoinContractError('invalid'); }
    const expected = await correction(scope, subsetActions, subsetRows, subset, hashing);
    if (!expected || canonicalCoinLedger(row) !== canonicalCoinLedger(expected)) throw new CoinContractError('invalid');
  }
  for (const row of [...rows.values()].filter((value) => value.kind === 'adjustment').sort((a, b) => compareCoinTuple([a.id], [b.id]))) {
    const old = row.adjustsId === null ? row : rows.get(row.adjustsId);
    if (!old) throw new CoinContractError('missing');
    if (old.kind !== 'adjustment' || old.adjustsId !== null) throw new CoinContractError('invalid');
    if (parseCoinProvenance(old.provenanceJson!).length >= facts.length) {
      if (row.adjustsId !== null) throw new CoinContractError('missing');
      continue;
    }
    const cancel = assertCoinLedgerShape({ ...old, id: await uuidV5(`cancel:${old.id}`, hashing) as LedgerEntryId, delta: -old.delta, adjustsId: old.id });
    if (row.adjustsId !== null && canonicalCoinLedger(cancel) !== canonicalCoinLedger(row)) throw new CoinContractError('invalid');
    append(cancel);
  }
  const current = await correction(scope, actions, ordinary, facts, hashing);
  if (current) append(current);
  return { appendedRows, target: replay.target, balance: coinLedgerTotals([...rows.values()]).balance };
}
