import type { SqlExecutor } from '../persistence/database';
import { appendHabitAction, listHabitActions } from '../persistence/repositories/habit-actions';
import { appendOutbox } from '../persistence/repositories/support';
import type { CommandContext, CommandDeps } from './command-context';
import type { CheckIn } from './entities';
import { baselineAction } from './habit-actions';
import type { HabitAction, HabitActionKind } from './habit-actions';
import type { CheckInId, CommandId, HabitActionId } from './ids';

// seed legacy survivors before a live mutation; any existing token evidence
// prevents a later import or removal from synthesizing its state again.
export async function seedLegacyCheckActions(
  deps: CommandDeps,
  tx: SqlExecutor,
  checks: readonly Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>[],
  now: number,
): Promise<void> {
  const knownByScope = new Map<string, Set<CheckInId | null>>();
  for (const check of checks) {
    const scope = `${check.boardId}|${check.logicalDate}`;
    let known = knownByScope.get(scope);
    if (!known) {
      const actions = await listHabitActions(tx, check.boardId, check.logicalDate);
      known = new Set(actions.map((action) => action.checkInId));
      knownByScope.set(scope, known);
    }
    if (known.has(check.id)) continue;
    const baseline = await baselineAction(check, deps.hashing);
    await appendHabitAction(tx, baseline);
    await appendOutbox(tx, 'habit_action', baseline.id, baseline.mutationStamp, now);
    known.add(check.id);
  }
}

export async function appendCheckAction(
  deps: CommandDeps,
  { tx, now }: CommandContext,
  commandId: CommandId,
  check: Pick<CheckIn, 'id' | 'boardId' | 'logicalDate'>,
  kind: Exclude<HabitActionKind, 'baseline' | 'policy'>,
  mutationStamp: string,
  checkInId: CheckInId | null = check.id,
): Promise<void> {
  const action: HabitAction = {
    id: deps.ids.uuid() as HabitActionId,
    commandId,
    boardId: check.boardId,
    logicalDate: check.logicalDate,
    checkInId,
    kind,
    createdAt: now,
    mutationStamp,
    policyJson: null,
  };
  await appendHabitAction(tx, action);
  await appendOutbox(tx, 'habit_action', action.id, mutationStamp, now);
}
