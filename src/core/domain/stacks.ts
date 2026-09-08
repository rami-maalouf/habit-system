import { normalizeBoardAnchorFields } from './board-anchor';
import type { AnchorPreset, Board } from './entities';
import type { BoardId } from './ids';
import { isUuidV4 } from './ids';
import type { DomainResult } from './result';
import { err, ok } from './result';
import { validateStartOfDayMinute } from './validation';

export type StackBoard = Pick<Board,
  'id' | 'anchorKind' | 'anchorRelation' | 'anchorBoardId' | 'anchorPreset' |
  'anchorText' | 'usualTimeMinute' | 'startOfDayMinute' | 'requiredInStack' |
  'orderKey' | 'archivedAt' | 'deletedAt'>;

export type DerivedStack = {
  rootId: BoardId;
  rootStartOfDayMinute: number;
  orderedMemberIds: BoardId[];
  activeMemberIds: BoardId[];
  // structural required flags only; date eligibility is a separate operation.
  requiredMemberIds: BoardId[];
  usualStartMinute: number;
};

function invalid(message: string) {
  return err('validation', message, { field: 'anchor' });
}

function validateBoard(board: StackBoard): DomainResult<void> {
  if (typeof board.id !== 'string' || !isUuidV4(board.id) || typeof board.orderKey !== 'string') {
    return invalid('Stack members need valid habit ids and home order.');
  }
  if (board.usualTimeMinute === undefined || board.requiredInStack === undefined) {
    return invalid('Stack members need a usual-time value and required-member flag.');
  }
  const anchor = board.anchorKind === null ? null
    : board.anchorKind === 'board' ? { kind: board.anchorKind, relation: board.anchorRelation!, boardId: board.anchorBoardId! }
      : board.anchorKind === 'preset' ? { kind: board.anchorKind, relation: board.anchorRelation!, preset: board.anchorPreset! }
        : board.anchorKind === 'text' ? { kind: board.anchorKind, relation: board.anchorRelation!, text: board.anchorText! }
          : undefined;
  if (anchor === undefined) return invalid('A stack member has an invalid anchor kind.');
  const normalized = normalizeBoardAnchorFields({ anchor, usualTimeMinute: board.usualTimeMinute, requiredInStack: board.requiredInStack });
  if (!normalized.ok) return normalized;
  if (Object.entries(normalized.value).some(([key, value]) => board[key as keyof StackBoard] !== value)) {
    return invalid('A stack member has inconsistent anchor fields.');
  }
  const shift = validateStartOfDayMinute(board.startOfDayMinute);
  return shift.ok ? ok(undefined) : shift;
}

function compare(left: StackBoard, right: StackBoard): number {
  if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
  return left.id < right.id ? -1 : 1;
}

// a local min-heap keeps wide ready sets deterministic without repeated sorting.
class ReadyBoards {
  private rows: StackBoard[] = [];

  get length() { return this.rows.length; }

  push(board: StackBoard) {
    this.rows.push(board);
    let index = this.rows.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(this.rows[parent], this.rows[index]) <= 0) break;
      [this.rows[parent], this.rows[index]] = [this.rows[index], this.rows[parent]];
      index = parent;
    }
  }

  pop(): StackBoard {
    const first = this.rows[0];
    const last = this.rows.pop()!;
    if (this.rows.length > 0) {
      this.rows[0] = last;
      let index = 0;
      while (index * 2 + 1 < this.rows.length) {
        const left = index * 2 + 1;
        const right = left + 1;
        const child = right < this.rows.length && compare(this.rows[right], this.rows[left]) < 0 ? right : left;
        if (compare(this.rows[index], this.rows[child]) <= 0) break;
        [this.rows[index], this.rows[child]] = [this.rows[child], this.rows[index]];
        index = child;
      }
    }
    return first;
  }
}

function orderMembers(members: StackBoard[], byId: ReadonlyMap<BoardId, StackBoard>): BoardId[] {
  const outgoing = new Map(members.map((member) => [member.id, [] as BoardId[]]));
  const incoming = new Map(members.map((member) => [member.id, 0]));
  const siblings = new Map<string, StackBoard[]>();
  const edge = (from: BoardId, to: BoardId) => {
    outgoing.get(from)!.push(to);
    incoming.set(to, incoming.get(to)! + 1);
  };
  for (const member of members) {
    if (member.anchorKind !== 'board') continue;
    const parent = member.anchorBoardId!;
    if (member.anchorRelation === 'before') edge(member.id, parent);
    else edge(parent, member.id);
    const key = `${parent}|${member.anchorRelation}`;
    const group = siblings.get(key) ?? [];
    group.push(member);
    siblings.set(key, group);
  }
  for (const group of siblings.values()) {
    group.sort(compare);
    for (let index = 1; index < group.length; index++) edge(group[index - 1].id, group[index].id);
  }
  const ready = new ReadyBoards();
  for (const member of members) if (incoming.get(member.id) === 0) ready.push(member);
  const ordered: BoardId[] = [];
  while (ready.length > 0) {
    const member = ready.pop();
    ordered.push(member.id);
    for (const next of outgoing.get(member.id)!) {
      const count = incoming.get(next)! - 1;
      incoming.set(next, count);
      if (count === 0) ready.push(byId.get(next)!);
    }
  }
  return ordered;
}

export function deriveStacks(
  boards: readonly StackBoard[],
  presetMinutes: Readonly<Record<AnchorPreset, number>>,
): DomainResult<DerivedStack[]> {
  for (const preset of ['wake', 'lunch', 'dinner', 'sleep'] as const) {
    const minute = presetMinutes[preset];
    if (!Number.isInteger(minute) || minute < 0 || minute > 1425 || minute % 15 !== 0) {
      return invalid('Built-in anchor times must use valid 15-minute steps.');
    }
  }
  const byId = new Map<BoardId, StackBoard>();
  for (const board of boards) {
    if (board.deletedAt !== null) continue;
    const valid = validateBoard(board);
    if (!valid.ok) return valid;
    if (byId.has(board.id)) return invalid('A stack contains a duplicate habit id.');
    byId.set(board.id, board);
  }
  const roots = new Map<BoardId, BoardId>();
  for (const board of byId.values()) {
    const path = new Set<BoardId>();
    let current = board;
    while (!roots.has(current.id) && current.anchorKind === 'board') {
      if (path.has(current.id)) return invalid('An anchor chain links a habit back to itself.');
      path.add(current.id);
      const parent = byId.get(current.anchorBoardId!);
      if (!parent) return invalid('An anchor habit no longer exists.');
      current = parent;
    }
    const rootId = roots.get(current.id) ?? current.id;
    roots.set(current.id, rootId);
    for (const memberId of path) roots.set(memberId, rootId);
  }
  const components = new Map<BoardId, StackBoard[]>();
  for (const board of byId.values()) {
    const rootId = roots.get(board.id)!;
    const members = components.get(rootId) ?? [];
    members.push(board);
    components.set(rootId, members);
  }
  const result: DerivedStack[] = [];
  const sortedRoots = [...components.keys()].sort((left, right) => compare(byId.get(left)!, byId.get(right)!));
  for (const rootId of sortedRoots) {
    const members = components.get(rootId)!;
    const root = byId.get(rootId)!;
    if (members.length === 1 && root.anchorKind === null) continue;
    const orderedMemberIds = orderMembers(members, byId);
    const activeMemberIds = orderedMemberIds.filter((memberId) => byId.get(memberId)!.archivedAt === null);
    const first = byId.get(activeMemberIds[0]);
    const usualStartMinute = first?.usualTimeMinute ??
      (first?.anchorKind === 'preset' && first.anchorRelation === 'after' ? presetMinutes[first.anchorPreset!] : 0);
    result.push({
      rootId, rootStartOfDayMinute: root.startOfDayMinute, orderedMemberIds, activeMemberIds,
      requiredMemberIds: members.filter((member) => member.requiredInStack).map((member) => member.id).sort(),
      usualStartMinute,
    });
  }
  return ok(result);
}
