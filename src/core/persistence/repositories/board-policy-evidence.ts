import { assertCoinLedgerShape, canonicalCoinLedger, type CoinLedgerRow } from '../../domain/coin-ledger';
import { CoinContractError, parseCoinPolicy } from '../../domain/coin-policy';
import { coinDigest, parseCoinProvenance, type CoinFingerprint } from '../../domain/coin-provenance';
import { canonicalHabitAction, validateHabitAction, type HabitAction } from '../../domain/habit-actions';
import type { BoardId, LogicalDate } from '../../domain/ids';
import type { Hashing } from '../../domain/ports';
import type { SqlExecutor } from '../database';

export type BoardPolicyPeriod = { id: number; startDate: LogicalDate; endDate: LogicalDate | null };

export async function readBoardPolicyPeriods(tx: SqlExecutor, boardIds: readonly BoardId[]) {
  const rows = await tx.getAllAsync<BoardPolicyPeriod & { boardId: BoardId }>(
    `SELECT id, board_id AS boardId, start_date AS startDate, end_date AS endDate FROM board_activity_periods
     WHERE deleted_at IS NULL AND board_id IN (SELECT value FROM json_each(?)) ORDER BY id`, [JSON.stringify(boardIds)]);
  const periods = new Map<BoardId, BoardPolicyPeriod[]>();
  for (const row of rows) {
    const list = periods.get(row.boardId) ?? [];
    list.push({ id: row.id, startDate: row.startDate, endDate: row.endDate });
    periods.set(row.boardId, list);
  }
  return periods;
}

export async function reopenBoardPolicyPeriod(tx: SqlExecutor, periodId: number, mutationStamp: string) {
  await tx.runAsync('UPDATE board_activity_periods SET end_date = NULL, mutation_stamp = ? WHERE id = ?', [mutationStamp, periodId]);
}

const actionColumns = `a.id, a.command_id AS commandId, a.board_id AS boardId,
  a.logical_date AS logicalDate, a.check_in_id AS checkInId, a.kind,
  a.created_at AS createdAt, a.mutation_stamp AS mutationStamp, a.policy_json AS policyJson`;
const ledgerColumns = `l.id, l.kind, l.delta, l.board_id AS boardId, l.check_in_id AS checkInId,
  l.run_key AS runKey, l.reward_id AS rewardId, l.reward_title_snapshot AS rewardTitleSnapshot,
  l.reverses_id AS reversesId, l.scope_key AS scopeKey, l.source_action_id AS sourceActionId,
  l.reconciliation_key AS reconciliationKey, l.adjusts_id AS adjustsId,
  l.provenance_json AS provenanceJson, l.logical_date AS logicalDate,
  l.created_at AS createdAt, l.mutation_stamp AS mutationStamp, l.deleted_at AS deletedAt`;

function checkedAction(action: HabitAction): HabitAction {
  const result = validateHabitAction(action);
  if (!result.ok) throw new CoinContractError(result.error.code === 'capacity' ? 'size' : 'invalid');
  return action;
}

function references(row: CoinLedgerRow) {
  const facts = row.provenanceJson === null ? [] : parseCoinProvenance(row.provenanceJson);
  return {
    facts,
    actions: [...new Set([row.sourceActionId, ...facts.filter(f => f[0] === 'habit_action').map(f => f[1])].filter(id => id !== null))],
    rows: [...new Set([row.reversesId, row.adjustsId, ...facts.filter(f => f[0] === 'ledger_entry').map(f => f[1])].filter(id => id !== null))],
  };
}

// discover dates without interpreting bonus entitlement or changing evidence.
export async function readOpenBoardPolicyDates(
  tx: SqlExecutor,
  hashing: Pick<Hashing, 'sha256'>,
  input: { boardIds: readonly BoardId[]; rootIds: readonly BoardId[]; now: number },
): Promise<LogicalDate[]> {
  const actions = new Map<string, HabitAction>();
  const rows = new Map<string, CoinLedgerRow>();
  const dates = new Set<LogicalDate>();
  if (input.boardIds.length > 0) {
    const selected = await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
      WHERE a.board_id IN (SELECT value FROM json_each(?)) AND a.policy_json IS NOT NULL
      AND CASE
        WHEN json_valid(a.policy_json) = 0 THEN 1
        WHEN json_type(a.policy_json, '$.rootId') IS NOT 'text' AND json_type(a.policy_json, '$.rootId') IS NOT 'null' THEN 1
        WHEN json_type(a.policy_json, '$.bonusClosesAtUtc') IS NOT 'integer' AND json_type(a.policy_json, '$.bonusClosesAtUtc') IS NOT 'null' THEN 1
        WHEN json_extract(a.policy_json, '$.bonusClosesAtUtc') NOT BETWEEN -9007199254740991 AND 9007199254740991
          OR (a.policy_json -> '$.bonusClosesAtUtc') = '-0' THEN 1
        WHEN json_type(a.policy_json, '$.rootId') = 'null' THEN json_type(a.policy_json, '$.bonusClosesAtUtc') IS NOT 'null'
        ELSE json_type(a.policy_json, '$.bonusClosesAtUtc') IS NOT 'integer' OR json_extract(a.policy_json, '$.bonusClosesAtUtc') > ?
      END`, [JSON.stringify(input.boardIds), input.now]);
    for (const action of selected) {
      actions.set(action.id, checkedAction(action));
      dates.add(action.logicalDate);
    }
  }
  const bonusRows = input.rootIds.length === 0 ? [] : await tx.getAllAsync<CoinLedgerRow>(
    `SELECT ${ledgerColumns} FROM json_each(?) roots JOIN coin_ledger l
     ON l.scope_key >= 'bonus:' || roots.value || ':' AND l.scope_key < 'bonus:' || roots.value || ';'`,
    [JSON.stringify([...new Set(input.rootIds)])]);
  for (const row of bonusRows) rows.set(row.id, assertCoinLedgerShape(row));
  const refs = new Map<string, ReturnType<typeof references>>();
  let pending = [...rows.values()];
  while (pending.length > 0) {
    const actionIds = new Set<string>();
    const ledgerIds = new Set<string>();
    for (const row of pending) {
      const ref = references(row);
      refs.set(row.id, ref);
      for (const id of ref.actions) if (!actions.has(id)) actionIds.add(id);
      for (const id of ref.rows) if (!rows.has(id)) ledgerIds.add(id);
    }
    if (actionIds.size > 0) {
      const found = await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a
        WHERE a.id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...actionIds])]);
      for (const action of found) actions.set(action.id, checkedAction(action));
      if ([...actionIds].some(id => !actions.has(id))) throw new CoinContractError('missing');
    }
    pending = ledgerIds.size === 0 ? [] : await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
      WHERE l.id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...ledgerIds])]);
    for (const row of pending) rows.set(row.id, assertCoinLedgerShape(row));
    if ([...ledgerIds].some(id => !rows.has(id))) throw new CoinContractError('missing');
  }
  const digests = new Map<string, string>();
  async function verify(fact: CoinFingerprint) {
    const key = JSON.stringify(fact.slice(0, 2));
    let digest = digests.get(key);
    if (digest === undefined) {
      digest = await coinDigest(fact[0] === 'habit_action'
        ? canonicalHabitAction(actions.get(fact[1])!) : canonicalCoinLedger(rows.get(fact[1])!), hashing);
      digests.set(key, digest);
    }
    if (digest !== fact[2]) throw new CoinContractError('invalid');
  }
  for (const [id, ref] of refs) {
    const row = rows.get(id)!;
    for (const actionId of ref.actions) {
      if (actions.get(actionId)!.logicalDate !== row.logicalDate) throw new CoinContractError('invalid');
    }
    for (const rowId of ref.rows) {
      const dependency = rows.get(rowId)!;
      if (dependency.scopeKey !== row.scopeKey || dependency.logicalDate !== row.logicalDate) throw new CoinContractError('invalid');
    }
    for (const fact of ref.facts) {
      if (fact[0] === 'ledger_entry' && ['claim', 'adjustment'].includes(rows.get(fact[1])!.kind)) throw new CoinContractError('invalid');
      await verify(fact);
    }
  }
  const open = new Map<string, boolean>();
  const visiting = new Set<string>();
  for (const seed of rows.keys()) {
    const stack: [string, boolean][] = [[seed, false]];
    while (stack.length > 0) {
      const [id, done] = stack.pop()!;
      if (open.has(id)) continue;
      const ref = refs.get(id)!;
      if (done) {
        // no captured bonus close is an unknown horizon, never inferred closed.
        const isOpen = ref.actions.some(actionId => {
          const action = actions.get(actionId)!;
          const close = action.policyJson === null ? null : parseCoinPolicy(action.policyJson).bonusClosesAtUtc;
          return close === null || close > input.now;
        }) || ref.rows.some(rowId => open.get(rowId));
        open.set(id, isOpen || (ref.actions.length === 0 && ref.rows.length === 0));
        visiting.delete(id);
      } else {
        if (visiting.has(id)) throw new CoinContractError('invalid');
        visiting.add(id);
        stack.push([id, true]);
        for (const next of ref.rows) stack.push([next, false]);
      }
    }
  }
  for (const row of bonusRows) if (open.get(row.id)) dates.add(row.logicalDate);
  return [...dates].sort();
}

// policy settlement reuses two bulk reads instead of querying every carrier/date.
export async function readBoardPolicyScopes(tx: SqlExecutor, scopes: readonly { boardId: BoardId; logicalDate: LogicalDate }[]) {
  const actions = await tx.getAllAsync<HabitAction>(`SELECT ${actionColumns} FROM habit_actions a JOIN json_each(?) scopes
    ON a.board_id = json_extract(scopes.value, '$.boardId') AND a.logical_date = json_extract(scopes.value, '$.logicalDate')`, [JSON.stringify(scopes)]);
  const rows = await tx.getAllAsync<CoinLedgerRow>(`SELECT ${ledgerColumns} FROM coin_ledger l
    WHERE l.scope_key IN (SELECT value FROM json_each(?))`, [JSON.stringify(scopes.map(scope => `check:${scope.boardId}:${scope.logicalDate}`))]);
  return { actions: actions.map(checkedAction), rows: rows.map(assertCoinLedgerShape) };
}
