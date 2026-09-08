import { isValidLogicalDate } from '../calendar/logical-date';
import { canonicalCoinPolicy, type CoinPolicy } from './coin-policy';
import { prepareCoinPolicyCapture, type CoinPolicyContext } from './coin-policy-capture';
import { isUuidV4, type BoardId, type LogicalDate } from './ids';
import { err, ok, type DomainResult } from './result';
import { deriveStacks } from './stacks';

export type CoinPolicyDraft = {
  boardId: BoardId;
  logicalDate: LogicalDate;
  kind: 'policy';
  checkInId: null;
  policyJson: string;
};

export type CoinPolicyEmissionInput = {
  before: CoinPolicyContext;
  after: CoinPolicyContext;
  changedBoardIds: readonly BoardId[];
  candidateDates: readonly LogicalDate[];
};

type CloseResolver = (date: LogicalDate, startMinute: number) => number;

function prepareState(context: CoinPolicyContext, resolveClose: CloseResolver) {
  const boards = context.boards.map((board) => ({ ...board }));
  const stacks = deriveStacks(boards, { wake: 0, lunch: 0, dinner: 0, sleep: 0 });
  if (!stacks.ok) return stacks;
  const capture = prepareCoinPolicyCapture({ ...context, boards }, resolveClose);
  if (!capture.ok) return capture;
  const roots = new Map(stacks.value.map((stack) => [stack.rootId, stack]));
  const rootsByMember = new Map(stacks.value.flatMap((stack) =>
    stack.orderedMemberIds.map((id) => [id, stack.rootId] as const)));
  return ok({ boards: new Map(boards.filter((board) => board.deletedAt === null).map((board) => [board.id, board])),
    roots, rootsByMember, capture: capture.value });
}

function bonusIdentity(policy: CoinPolicy) {
  return JSON.stringify([policy.rootId, policy.requiredBoardIds, policy.bonusClosesAtUtc, policy.bonusEnabled]);
}

// dates, transaction, entropy and storage belong to the caller.
export function planCoinPolicyEmission(
  input: CoinPolicyEmissionInput,
  resolveClose: CloseResolver,
): DomainResult<readonly CoinPolicyDraft[]> {
  if (input.changedBoardIds.some((id) => typeof id !== 'string' || !isUuidV4(id)) ||
    input.candidateDates.some((date) => typeof date !== 'string' || !isValidLogicalDate(date))) {
    return err('validation', 'Policy emission needs valid habit ids and stored dates.', { field: 'coins' });
  }
  const before = prepareState(input.before, resolveClose);
  if (!before.ok) return before;
  const after = prepareState(input.after, resolveClose);
  if (!after.ok) return after;
  const states = [before.value, after.value];
  const changed = [...new Set(input.changedBoardIds)].sort();
  if (changed.some((id) => !states.some((state) => state.boards.has(id)))) {
    return err('not_found', 'An edited habit is outside both policy snapshots.');
  }
  const dates = [...new Set(input.candidateDates)].sort();
  const affectedRoots = new Set<BoardId>();
  const affectedIds = new Set(changed);
  const expanded = states.map(() => new Set<BoardId>());
  // expand each old/new component once, including splits and merges.
  for (const id of affectedIds) {
    states.forEach((state, index) => {
      const rootId = state.rootsByMember.get(id);
      if (rootId === undefined || expanded[index].has(rootId)) return;
      expanded[index].add(rootId);
      affectedRoots.add(rootId);
      for (const member of state.roots.get(rootId)!.orderedMemberIds) affectedIds.add(member);
    });
  }
  const roots = [...affectedRoots].sort();
  const subjects = [...new Set([...changed, ...roots])];
  const policies = states.map(() => new Map<BoardId, Map<LogicalDate, CoinPolicy>>());
  for (const [index, state] of states.entries()) {
    for (const id of subjects) {
      if (!state.boards.has(id)) continue;
      const byDate = new Map<LogicalDate, CoinPolicy>();
      for (const date of dates) {
        const captured = state.capture({ boardId: id, logicalDate: date });
        if (!captured.ok) return captured;
        byDate.set(date, captured.value);
      }
      policies[index].set(id, byDate);
    }
  }
  const drafts: CoinPolicyDraft[] = [];
  const seen = new Set<string>();
  const append = (boardId: BoardId, logicalDate: LogicalDate, policy: CoinPolicy) => {
    const policyJson = canonicalCoinPolicy(policy);
    const key = JSON.stringify([boardId, logicalDate, policyJson]);
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push({ boardId, logicalDate, kind: 'policy', checkInId: null, policyJson });
  };
  for (const id of roots) {
    if (!before.value.roots.has(id) || after.value.roots.has(id)) continue;
    for (const date of dates) append(id, date, { ...policies[0].get(id)!.get(date)!, bonusEnabled: false });
  }
  for (const id of roots) {
    if (!after.value.roots.has(id)) continue;
    for (const date of dates) {
      const policy = policies[1].get(id)!.get(date)!;
      if (!before.value.roots.has(id) || bonusIdentity(policies[0].get(id)!.get(date)!) !== bonusIdentity(policy)) {
        append(id, date, policy);
      }
    }
  }
  for (const id of changed) {
    const previous = before.value.boards.get(id);
    const next = after.value.boards.get(id);
    if (!previous || !next || (['kind', 'earnsCoins', 'coinCapPerDay', 'startOfDayMinute'] as const)
      .every((key) => previous[key] === next[key])) continue;
    for (const date of dates) append(id, date, policies[1].get(id)!.get(date)!);
  }
  return ok(drafts);
}
