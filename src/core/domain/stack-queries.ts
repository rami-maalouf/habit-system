import { currentLogicalDate } from '../calendar/logical-date';
import { nextWidgetRefreshUtc } from '../calendar/widget-refresh';
import type { SqlExecutor } from '../persistence/database';
import { listUndeletedBoards } from '../persistence/repositories/boards';
import { readStackEvidence } from '../persistence/repositories/stack-evidence';
import { getSettings } from '../persistence/repositories/support';
import type { AnchorPreset, Board } from './entities';
import { isUuidV4, type BoardId } from './ids';
import { runQuery, type QueryDeps } from './queries';
import { err, ok, type DomainResult } from './result';
import { analyzeStackHistory, memberChecksThisWeek, stackHeatmap } from './stack-analytics';
import type { StackHeatmapCell, StackHistoryMetrics } from './stack-analytics';
import { isStackDateEligible, type StackRunEvidence } from './stack-runs';
import { deriveStacks, type DerivedStack } from './stacks';

export type StackMember = Pick<Board, 'id' | 'title' | 'symbol' | 'accentHex' | 'kind' | 'requiredInStack'> & {
  // checked describes stored evidence independently of stack eligibility.
  checked: boolean;
  eligible: boolean;
};
export type StackTimeHint = { kind: 'usualTime'; minute: number } |
  { kind: 'preset'; preset: AnchorPreset; minute: number } | null;
export type StackSummary = Pick<StackHistoryMetrics, 'currentRun' | 'completeRunsThisWeek' | 'currentStreak'> & {
  rootId: BoardId;
  rootStartOfDayMinute: number;
  members: StackMember[];
  timeHint: StackTimeHint;
};
export type StackListSnapshot = {
  generatedAtUtc: number;
  timeZoneId: string;
  // conservative display refresh, never an economic day-close timestamp.
  refreshAtUtc: number | null;
  stacks: StackSummary[];
};
export type StackDetailSnapshot = Omit<StackListSnapshot, 'stacks' | 'refreshAtUtc'> & {
  refreshAtUtc: number;
  stack: StackSummary & {
    longestStreak: number;
    heatmap: StackHeatmapCell[];
    memberWeeklyCounts: { boardId: BoardId; checks: number }[];
  };
};

async function readSnapshot(tx: SqlExecutor) {
  const settings = await getSettings(tx);
  if (!settings) throw new Error('App settings are missing.');
  const presets = { wake: settings.wakeMinute, lunch: settings.lunchMinute, dinner: settings.dinnerMinute, sleep: settings.sleepMinute };
  const boards = await listUndeletedBoards(tx);
  const derived = deriveStacks(boards, presets);
  if (!derived.ok) return derived;
  return ok({ boards: new Map(boards.map((board) => [board.id, board])), presets, stacks: derived.value });
}
type Snapshot = Extract<Awaited<ReturnType<typeof readSnapshot>>, { ok: true }>['value'] & Awaited<ReturnType<typeof readStackEvidence>>;

function timeHint(first: Board, presets: Readonly<Record<AnchorPreset, number>>): StackTimeHint {
  if (first.usualTimeMinute !== null) return { kind: 'usualTime', minute: first.usualTimeMinute };
  if (first.anchorKind === 'preset' && first.anchorRelation === 'after' && first.anchorPreset !== null) {
    return { kind: 'preset', preset: first.anchorPreset, minute: presets[first.anchorPreset] };
  }
  return null;
}

function summarize(stack: DerivedStack, snapshot: Snapshot, now: number, timeZoneId: string) {
  const evidence: StackRunEvidence = {
    today: currentLogicalDate(now, timeZoneId, stack.rootStartOfDayMinute),
    periodsByBoard: snapshot.periodsByBoard, countsByBoard: snapshot.countsByBoard,
  };
  const active = stack.activeMemberIds.map((id) => snapshot.boards.get(id)!);
  const metrics = analyzeStackHistory(stack, evidence);
  const summary: StackSummary = {
    rootId: stack.rootId, rootStartOfDayMinute: stack.rootStartOfDayMinute,
    members: active.map(({ id, title, symbol, accentHex, kind, requiredInStack }) => ({
      id, title, symbol, accentHex, kind, requiredInStack,
      checked: (evidence.countsByBoard.get(id)?.get(evidence.today) ?? 0) > 0,
      eligible: isStackDateEligible(evidence.today, evidence.periodsByBoard.get(id) ?? [], evidence.today),
    })),
    timeHint: timeHint(active[0], snapshot.presets),
    currentRun: metrics.currentRun, completeRunsThisWeek: metrics.completeRunsThisWeek, currentStreak: metrics.currentStreak,
  };
  return { summary, evidence, longestStreak: metrics.longestStreak };
}

export async function getStackListSnapshot(deps: QueryDeps): Promise<DomainResult<StackListSnapshot>> {
  const result = await runQuery(deps, async (tx, now, timeZoneId) => {
    const snapshot = await readSnapshot(tx);
    if (!snapshot.ok) return snapshot;
    const visible = snapshot.value.stacks.filter((stack) => stack.activeMemberIds.length > 0);
    if (visible.length === 0) return ok({ generatedAtUtc: now, timeZoneId, refreshAtUtc: null, stacks: [] });
    const evidence = await readStackEvidence(tx, visible.flatMap((stack) => stack.orderedMemberIds));
    const data = { ...snapshot.value, ...evidence };
    return ok({
      generatedAtUtc: now, timeZoneId,
      refreshAtUtc: nextWidgetRefreshUtc(now, timeZoneId, visible.map((stack) => stack.rootStartOfDayMinute)),
      stacks: visible.map((stack) => summarize(stack, data, now, timeZoneId).summary),
    });
  });
  return result.ok ? result.value : result;
}

export async function getStackDetailSnapshot(deps: QueryDeps, rootId: BoardId): Promise<DomainResult<StackDetailSnapshot>> {
  if (typeof rootId !== 'string' || !isUuidV4(rootId)) return err('validation', 'Choose a valid stack.', { field: 'rootId' });
  const result = await runQuery(deps, async (tx, now, timeZoneId) => {
    const snapshot = await readSnapshot(tx);
    if (!snapshot.ok) return snapshot;
    const stack = snapshot.value.stacks.find((candidate) => candidate.rootId === rootId && candidate.activeMemberIds.length > 0);
    if (!stack) return err('not_found', 'This stack is no longer available.');
    const data = { ...snapshot.value, ...await readStackEvidence(tx, stack.orderedMemberIds) };
    const { summary, evidence, longestStreak } = summarize(stack, data, now, timeZoneId);
    return ok({
      generatedAtUtc: now, timeZoneId,
      refreshAtUtc: nextWidgetRefreshUtc(now, timeZoneId, [stack.rootStartOfDayMinute]),
      stack: {
        ...summary, longestStreak, heatmap: stackHeatmap(stack, evidence),
        memberWeeklyCounts: summary.members.map(({ id, kind }) => ({ boardId: id, checks: memberChecksThisWeek(id, kind, evidence) })),
      },
    });
  });
  return result.ok ? result.value : result;
}
