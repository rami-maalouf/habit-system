import { createHash } from 'node:crypto';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import fixture from '@/core/automations/fixtures/coin-policy-emission.json';
import { createEconomicDayCloseResolver } from '@/core/calendar/economic-day-close';
import type { ActivityPeriodRange } from '@/core/calendar/periods';
import type { CoinPolicyBoard, CoinPolicyContext } from '@/core/domain/coin-policy-capture';
import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import { planCoinPolicyEmission } from '@/core/domain/coin-policy-emission';
import { replayCheckCoins } from '@/core/domain/coins';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import * as stacks from '@/core/domain/stacks';

const rootId = '00000000-0000-4000-8000-000000000001' as BoardId;
const otherId = '00000000-0000-4000-8000-000000000099' as BoardId;
const date = '2026-09-08' as LogicalDate;
const resolver = createEconomicDayCloseResolver('UTC');
const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};

type Period = { boardId: string; startDate: string; endDate: string | null };

function context(rows: readonly { id: string; [key: string]: unknown }[], periods?: readonly Period[]): CoinPolicyContext {
  const boards = rows.map((row) => ({ ...fixture.boardDefaults, ...row, id: row.id as BoardId }) as CoinPolicyBoard);
  const periodsByBoard = new Map<BoardId, ActivityPeriodRange[]>();
  for (const period of periods ?? boards.map((board) => ({ boardId: board.id, ...fixture.defaultPeriod }))) {
    const ranges = periodsByBoard.get(period.boardId as BoardId) ?? [];
    ranges.push({ startDate: period.startDate as LogicalDate, endDate: period.endDate as LogicalDate | null });
    periodsByBoard.set(period.boardId as BoardId, ranges);
  }
  return { boards, periodsByBoard };
}

function plan(before: CoinPolicyContext, after: CoinPolicyContext, changedBoardIds = [rootId], candidateDates = [date]) {
  return planCoinPolicyEmission({ before, after, changedBoardIds, candidateDates }, resolver);
}

describe('prospective coin policy emission', () => {
  it.each(fixture.cases)('$name', (item) => {
    const before = context(item.before, item.beforePeriods);
    const after = context(item.after, item.afterPeriods);
    const immutableInputs = JSON.stringify([item, [...before.periodsByBoard], [...after.periodsByBoard]]);
    for (const state of [before, after]) {
      state.boards.forEach(Object.freeze);
      Object.freeze(state.boards);
      for (const ranges of state.periodsByBoard.values()) {
        ranges.forEach(Object.freeze);
        Object.freeze(ranges);
      }
    }
    const result = planCoinPolicyEmission({ before, after,
      changedBoardIds: item.changedBoardIds as BoardId[], candidateDates: item.candidateDates as LogicalDate[] },
    createEconomicDayCloseResolver(fixture.timeZoneId));
    expect(result).toEqual({ ok: true, value: item.expected });
    expect(JSON.stringify([item, [...before.periodsByBoard], [...after.periodsByBoard]])).toBe(immutableInputs);
  });

  it('is invariant to duplicate requested dates and ids or snapshot input ordering', () => {
    const item = fixture.cases[0];
    const before = context([...item.before].reverse());
    const after = context([...item.after].reverse());
    expect(plan(before, after, [...item.changedBoardIds, ...item.changedBoardIds] as BoardId[], [date, date]))
      .toEqual({ ok: true, value: item.expected });
  });

  it('does not emit unrelated component policies or fill unspecified dates', () => {
    const before = context([{ id: rootId }, { id: otherId, anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake' }]);
    const after = context([{ id: rootId, usualTimeMinute: 0 }, { ...before.boards[1], requiredInStack: false }]);
    expect(plan(before, after)).toEqual({ ok: true, value: [] });
    expect(plan(before, after, [], [date])).toEqual({ ok: true, value: [] });
    expect(plan(before, after, [otherId], [])).toEqual({ ok: true, value: [] });
  });

  it.each([['id', undefined], ['id', 'bad'], ['date', undefined], ['date', '2026-02-30']])(
    'rejects malformed %s %s before resolving closes', (field, value) => {
      const state = context([{ id: rootId }]);
      const resolve = jest.fn(resolver);
      expect(planCoinPolicyEmission({ before: state, after: state,
        changedBoardIds: [field === 'id' ? value : rootId] as BoardId[],
        candidateDates: [field === 'date' ? value : date] as LogicalDate[] }, resolve))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
      expect(resolve).not.toHaveBeenCalled();
    });

  it('rejects requested habits absent or already deleted from both snapshots', () => {
    const state = context([{ id: rootId, deletedAt: 1 }]);
    expect(plan(state, state)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(plan(context([]), context([]))).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it.each(['before', 'after'] as const)('rejects invalid %s topology, periods and check settings', (side) => {
    const good = context([{ id: rootId }]);
    const invalidStates = [
      context([{ id: rootId, anchorKind: 'board', anchorRelation: 'after', anchorBoardId: rootId }]),
      context([{ id: rootId }], [{ boardId: rootId, startDate: 'bad', endDate: null }]),
      context([{ id: rootId, coinCapPerDay: 11 }]),
    ];
    for (const invalid of invalidStates) {
      expect(plan(side === 'before' ? invalid : good, side === 'after' ? invalid : good))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
    }
  });

  it('validates a new rootless capture even though creation emits no policy', () => {
    expect(plan(context([]), context([{ id: rootId, earnsCoins: 1 as unknown as boolean }])))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('returns validation for invalid calendar results but preserves unexpected resolver failures', () => {
    const state = context([{ id: rootId }]);
    for (const resolve of [() => -0, () => { throw new RangeError('bad calendar'); }]) {
      expect(planCoinPolicyEmission({ before: state, after: state, changedBoardIds: [rootId], candidateDates: [date] }, resolve))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    const failure = new Error('calendar runtime unavailable');
    expect(() => planCoinPolicyEmission({ before: state, after: state, changedBoardIds: [rootId], candidateDates: [date] },
      () => { throw failure; })).toThrow(failure);
  });

  it('accepts reversed and overlapping valid periods with exact-date eligibility', () => {
    const before = context([{ id: rootId, anchorKind: 'preset', anchorRelation: 'after', anchorPreset: 'wake' }],
      [{ boardId: rootId, startDate: date, endDate: '2026-09-07' }]);
    const after = context(before.boards, [{ boardId: rootId, startDate: date, endDate: '2026-09-07' },
      { boardId: rootId, startDate: date, endDate: null }, { boardId: rootId, startDate: date, endDate: null }]);
    const result = plan(before, after);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toHaveLength(1);
    expect(JSON.parse(result.value[0].policyJson)).toMatchObject({ requiredBoardIds: [rootId], bonusEnabled: true });
  });

  it('rejects an oversized prospective membership atomically with the existing capacity result', () => {
    const members = Array.from({ length: 5100 }, (_, index) => ({ id: `00000000-0000-4000-8000-${(index + 100).toString(16).padStart(12, '0')}` as BoardId,
      anchorKind: 'board' as const, anchorRelation: 'after' as const, anchorBoardId: rootId, requiredInStack: false }));
    const before = context([{ id: rootId, requiredInStack: false }, ...members]);
    const after = context(before.boards.map((board) => ({ ...board, requiredInStack: true })));
    expect(plan(before, after)).toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
  });

  it('reuses a constant number of structural derivations across many explicit dates', () => {
    const derive = jest.spyOn(stacks, 'deriveStacks');
    try {
      const item = fixture.cases[0];
      const result = plan(context(item.before), context(item.after), item.changedBoardIds as BoardId[],
        Array.from({ length: 28 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}` as LogicalDate));
      expect(result.ok).toBe(true);
      expect(derive.mock.calls.length).toBeLessThanOrEqual(4);
    } finally { derive.mockRestore(); }
  });

  it.each(checkFixture.cases.slice(0, 3))('policy edits preserve source earnings and active state: $name', async (item) => {
    const boardId = checkFixture.scope.boardId as BoardId;
    const before = context([{ id: boardId, kind: 'count', earnsCoins: true, startOfDayMinute: 240 }]);
    const after = context([{ id: boardId, kind: 'daily', earnsCoins: false, coinCapPerDay: 10 }]);
    const result = plan(before, after, [boardId]);
    if (!result.ok) throw new Error(result.error.message);
    const policyAction: HabitAction = { ...result.value[0], id: '00000000-0000-4000-8000-00000000e001' as never,
      commandId: '00000000-0000-4000-8000-00000000e002' as never,
      createdAt: 1788868800000, mutationStamp: '01788868800000-00000-policy' };
    const scope = { boardId, logicalDate: date };
    const actions = item.actions as HabitAction[];
    expect(await replayCheckCoins(scope, [...actions, policyAction], hashing)).toEqual(await replayCheckCoins(scope, actions, hashing));
  });

  it('opting in never invents earnings for a retained genuine completion', async () => {
    const boardId = checkFixture.scope.boardId as BoardId;
    const result = plan(context([{ id: boardId }]), context([{ id: boardId, earnsCoins: true }]), [boardId]);
    if (!result.ok) throw new Error(result.error.message);
    const source = { ...checkFixture.cases[0].actions[0], policyJson: canonicalCoinPolicy({ ...checkFixture.policy, earnsCoins: false }) } as HabitAction;
    const policyAction: HabitAction = { ...result.value[0], id: '00000000-0000-4000-8000-00000000e001' as never,
      commandId: '00000000-0000-4000-8000-00000000e002' as never,
      createdAt: 1788868800000, mutationStamp: '01788868800000-00000-policy' };
    expect(await replayCheckCoins({ boardId, logicalDate: date }, [source, policyAction], hashing))
      .toMatchObject({ target: 0, ordinaryRows: [], activeCheckInIds: [source.checkInId] });
  });
});
