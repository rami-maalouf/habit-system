import type { SqlExecutor } from '../persistence/database';
import { listHabitActions } from '../persistence/repositories/habit-actions';
import { appendLedgerEntry, listLedgerEntriesForScope } from '../persistence/repositories/ledger';
import { appendOutbox } from '../persistence/repositories/support';
import type { CoinLedgerRow } from './coin-ledger';
import { reconcileCheckCoins } from './coin-reconciliation';
import type { CheckCoinScope } from './coins';
import type { CommandContext, CommandDeps } from './command-context';

// callers own the transaction and validate the economic cause before appending.
export async function appendLocalLedgerEntry(tx: SqlExecutor, row: CoinLedgerRow, now: number): Promise<boolean> {
  const inserted = await appendLedgerEntry(tx, row);
  if (inserted) await appendOutbox(tx, 'ledger_entry', row.id, row.mutationStamp, now);
  return inserted;
}

// settlement shares the writer's exclusive transaction; any failure rolls it back.
export async function settleCheckCoinScope(
  deps: Pick<CommandDeps, 'hashing'>,
  context: Pick<CommandContext, 'tx' | 'now'>,
  scope: CheckCoinScope,
) {
  const actions = await listHabitActions(context.tx, scope.boardId, scope.logicalDate);
  const rows = await listLedgerEntriesForScope(context.tx, `check:${scope.boardId}:${scope.logicalDate}`);
  const result = await reconcileCheckCoins(scope, actions, rows, deps.hashing);
  for (const row of result.appendedRows) await appendLocalLedgerEntry(context.tx, row, context.now);
  return result;
}
