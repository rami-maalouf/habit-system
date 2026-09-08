import { deriveStacks, type StackBoard } from '@/core/domain/stacks';
import type { AnchorPreset } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';

const presets: Readonly<Record<AnchorPreset, number>> = Object.freeze({ wake: 420, lunch: 720, dinner: 1080, sleep: 1380 });
const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}` as BoardId;
function board(value: number, extra: Partial<StackBoard> = {}): StackBoard {
  return {
    id: id(value), anchorKind: null, anchorRelation: null, anchorBoardId: null,
    anchorPreset: null, anchorText: null, usualTimeMinute: null, startOfDayMinute: 0,
    requiredInStack: true, orderKey: value.toString().padStart(4, '0'), archivedAt: null, deletedAt: null,
    ...extra,
  };
}
function child(value: number, parent: number, relation: 'before' | 'after', extra: Partial<StackBoard> = {}) {
  return board(value, { anchorKind: 'board', anchorRelation: relation, anchorBoardId: id(parent), ...extra });
}
function stacks(boards: readonly StackBoard[], times = presets) {
  const result = deriveStacks(boards, times);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('pure stack topology', () => {
  it('separates the structural root and its shift from the first displayed Before member', () => {
    const root = board(1, { startOfDayMinute: 240 });
    const before = child(2, 1, 'before', { usualTimeMinute: 465, startOfDayMinute: 0 });
    const after = child(3, 1, 'after', { requiredInStack: false });
    expect(stacks([after, root, before])).toEqual([{
      rootId: id(1), rootStartOfDayMinute: 240, orderedMemberIds: [id(2), id(1), id(3)],
      activeMemberIds: [id(2), id(1), id(3)], requiredMemberIds: [id(1), id(2)], usualStartMinute: 465,
    }]);
  });

  it.each(['before', 'after'] as const)('enforces %s sibling home order when an earlier sibling has an unmet predecessor', (relation) => {
    const rows = [board(1), child(2, 1, relation), child(3, 1, relation), child(4, 2, 'before')];
    const expected = relation === 'before' ? [id(4), id(2), id(3), id(1)] : [id(1), id(4), id(2), id(3)];
    expect(stacks(rows)[0].orderedMemberIds).toEqual(expected);
    expect(stacks([...rows].reverse())).toEqual(stacks(rows));
  });

  it('uses id ties and relation constraints before ready-node home priority without mutating frozen input', () => {
    const rows = Object.freeze([
      Object.freeze(child(5, 1, 'after', { orderKey: 'a' })),
      Object.freeze(child(3, 1, 'before', { orderKey: 'a' })),
      Object.freeze(board(1, { orderKey: 'a' })),
      Object.freeze(child(4, 1, 'after', { orderKey: 'a' })),
      Object.freeze(child(2, 1, 'before', { orderKey: 'a' })),
    ]);
    const original = JSON.stringify(rows);
    expect(stacks(rows)[0].orderedMemberIds).toEqual([id(2), id(3), id(1), id(4), id(5)]);
    expect(JSON.stringify(rows)).toBe(original);
  });

  it('keeps archived roots and internal nodes in ordering and required metadata before display filtering', () => {
    const rows = [board(1, { archivedAt: 1, startOfDayMinute: 360 }), child(2, 1, 'before', { archivedAt: 1 }), child(3, 2, 'after')];
    const [stack] = stacks(rows);
    expect(stack).toEqual({ rootId: id(1), rootStartOfDayMinute: 360, orderedMemberIds: [id(2), id(1), id(3)], activeMemberIds: [id(3)], requiredMemberIds: [id(1), id(2), id(3)], usualStartMinute: 0 });
    expect(stacks(rows.map((row) => ({ ...row, archivedAt: 1 })))[0]).toEqual({ ...stack, activeMemberIds: [] });
  });

  it('excludes unanchored singletons and tombstones without merging equal preset or text anchors', () => {
    const rows = [board(1), board(2, { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake' }), board(3, { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake' }), board(4, { anchorKind: 'text', anchorRelation: 'after', anchorText: 'getting home' }), board(5, { anchorKind: 'text', anchorRelation: 'after', anchorText: 'getting home', archivedAt: 1 }), board(6, { deletedAt: 1 })];
    expect(stacks(rows).map((stack) => stack.rootId)).toEqual([id(2), id(3), id(4), id(5)]);
    expect(stacks([])).toEqual([]);
    expect(stacks([rows[0], rows[5]])).toEqual([]);
  });

  it.each([
    { anchorKind: 'preset', anchorPreset: 'wake', anchorRelation: 'after', usualTimeMinute: null, expected: 420 },
    { anchorKind: 'preset', anchorPreset: 'lunch', anchorRelation: 'before', usualTimeMinute: null, expected: 0 },
    { anchorKind: 'preset', anchorPreset: 'sleep', anchorRelation: 'after', usualTimeMinute: 0, expected: 0 },
    { anchorKind: 'text', anchorText: 'getting home', anchorRelation: 'before', usualTimeMinute: 1425, expected: 1425 },
    { anchorKind: 'text', anchorText: 'getting home', anchorRelation: 'after', usualTimeMinute: null, expected: 0 },
  ] as const)('derives only the first active board informational hint: $expected', ({ expected, ...extra }) => {
    expect(stacks([board(1, extra)])[0].usualStartMinute).toBe(expected);
  });

  it('does not pull a later root preset before a displayed child or change the root shift when hints change', () => {
    const root = board(1, { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake', startOfDayMinute: 120 });
    const rows = [root, child(2, 1, 'before')];
    expect(stacks(rows)[0].usualStartMinute).toBe(0);
    expect(stacks([root])[0].usualStartMinute).toBe(420);
    expect(stacks([root], { ...presets, wake: 450 })[0]).toEqual({ ...stacks([root])[0], usualStartMinute: 450 });
    expect(stacks([{ ...root, archivedAt: 1 }, child(2, 1, 'before', { usualTimeMinute: 735 })])[0])
      .toMatchObject({ rootId: id(1), rootStartOfDayMinute: 120, usualStartMinute: 735 });
  });

  it.each([
    [child(1, 1, 'before')],
    [child(1, 2, 'after'), child(2, 1, 'before')],
    [child(1, 2, 'after'), child(2, 3, 'before'), child(3, 1, 'after')],
    [child(1, 2, 'after')],
    [child(1, 2, 'after'), board(2, { deletedAt: 1 })],
    [board(1), board(1)],
  ])('rejects cycles, missing/deleted references, and duplicate ids: %j', (...rows) => {
    expect(deriveStacks(rows, presets)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each([
    { anchorKind: null, anchorText: 'orphan text' },
    { anchorKind: 'unknown' },
    { anchorKind: 'board', anchorRelation: 'after', anchorBoardId: null },
    { anchorKind: 'board', anchorRelation: 'after', anchorBoardId: 'invalid' },
    { anchorKind: 'board', anchorRelation: 'after', anchorBoardId: id(2), anchorText: 'extra' },
    { anchorKind: 'preset', anchorRelation: null, anchorPreset: 'wake' },
    { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'other' },
    { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake', anchorBoardId: id(2) },
    { anchorKind: 'text', anchorRelation: 'before', anchorText: '  padded  ' },
    { anchorKind: 'text', anchorRelation: 'before', anchorText: '𐐀'.repeat(81) },
    { anchorKind: 'text', anchorRelation: 'before', anchorText: 'text', anchorPreset: 'wake' },
    { id: 'invalid' }, { orderKey: null }, { usualTimeMinute: 16 }, { requiredInStack: null }, { startOfDayMinute: 15 },
    { usualTimeMinute: undefined }, { requiredInStack: undefined },
  ])('rejects malformed flat board state without normalizing it silently: %j', (extra) => {
    expect(deriveStacks([board(1, extra as Partial<StackBoard>), board(2)], presets))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each([undefined, '420', -15, 16, 1439, NaN, Infinity])('rejects invalid preset display input %p', (wake) => {
    expect(deriveStacks([], { ...presets, wake } as Record<AnchorPreset, number>))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('handles a deep chain and wide siblings without recursion or dense sibling edges', () => {
    const depth = 3000;
    const chain = [board(1), ...Array.from({ length: depth - 1 }, (_, index) => child(index + 2, index + 1, 'after'))];
    expect(stacks([...chain].reverse())[0].orderedMemberIds).toEqual(chain.map((row) => row.id));
    const wide = [board(1), ...Array.from({ length: depth - 1 }, (_, index) => child(index + 2, 1, 'after'))];
    expect(stacks([...wide].reverse())[0].orderedMemberIds).toEqual(wide.map((row) => row.id));
  });

  it('preserves every edge, sibling order and identity across seeded branching forests and input permutations', () => {
    let seed = 20260908;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 80; trial++) {
      const rows = Array.from({ length: 40 }, (_, index) => {
        const extra = { orderKey: String(Math.floor(random() * 5)), archivedAt: random() < 0.3 ? 1 : null, requiredInStack: random() < 0.7 };
        return index === 0 || random() < 0.1
          ? board(index + 1, { anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake', ...extra })
          : child(index + 1, Math.floor(random() * index) + 1, random() < 0.5 ? 'before' : 'after', extra);
      });
      const result = stacks(rows);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const stackFor = new Map(result.flatMap((stack) => stack.orderedMemberIds.map((memberId) => [memberId, stack] as const)));
      expect(stackFor.size).toBe(rows.length);
      for (const row of rows) {
        let root = row;
        while (root.anchorKind === 'board') root = byId.get(root.anchorBoardId!)!;
        expect(stackFor.get(row.id)!.rootId).toBe(root.id);
        if (row.anchorKind !== 'board') continue;
        const order = stackFor.get(row.id)!.orderedMemberIds;
        const relative = order.indexOf(row.id) - order.indexOf(row.anchorBoardId!);
        expect(row.anchorRelation === 'before' ? relative < 0 : relative > 0).toBe(true);
        const siblings = rows.filter((other) => other.anchorBoardId === row.anchorBoardId && other.anchorRelation === row.anchorRelation)
          .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : left.id < right.id ? -1 : 1);
        expect(order.filter((memberId) => siblings.some((sibling) => sibling.id === memberId))).toEqual(siblings.map((sibling) => sibling.id));
      }
      const shuffled = [...rows];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
      }
      expect(stacks(shuffled)).toEqual(result);
    }
  });
});
