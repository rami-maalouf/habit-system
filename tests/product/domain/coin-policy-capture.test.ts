import fixture from '@/core/automations/fixtures/coin-policy-capture.json';
import { createEconomicDayCloseResolver } from '@/core/calendar/economic-day-close';
import { currentLogicalDate } from '@/core/calendar/logical-date';
import type { ActivityPeriodRange } from '@/core/calendar/periods';
import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import {
  prepareCoinPolicyCapture,
  readCoinPolicyCapture,
  type CoinPolicyBoard,
  type CoinPolicyContext,
} from '@/core/domain/coin-policy-capture';
import { archiveBoard, createBoard, restoreBoard } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import * as stacks from '@/core/domain/stacks';
import type { SqlExecutor } from '@/core/persistence/database';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const rootId = '00000000-0000-4000-8000-000000000001' as BoardId;
const childId = '00000000-0000-4000-8000-000000000002' as BoardId;
const otherId = '00000000-0000-4000-8000-000000000099' as BoardId;
const date = '2026-09-08' as LogicalDate;
const close = 1788912000000;

function contextFrom(item: (typeof fixture.cases)[number]): CoinPolicyContext {
  const periodsByBoard = new Map<BoardId, ActivityPeriodRange[]>();
  for (const period of item.periods) {
    const boardId = period.boardId as BoardId;
    const ranges = periodsByBoard.get(boardId) ?? [];
    ranges.push({ startDate: period.startDate as LogicalDate, endDate: period.endDate as LogicalDate | null });
    periodsByBoard.set(boardId, ranges);
  }
  return { boards: item.boards.map((row) => ({ ...row }) as CoinPolicyBoard), periodsByBoard };
}

function basicContext() { return contextFrom(fixture.cases[0]); }
function subject(boardId = rootId, logicalDate = date) { return { boardId, logicalDate }; }

describe('prepared coin policy capture', () => {
  it.each(fixture.cases)('captures literal policy: $name', (item) => {
    const context = contextFrom(item);
    const before = JSON.stringify(item);
    for (const board of context.boards) Object.freeze(board);
    Object.freeze(context.boards);
    for (const ranges of context.periodsByBoard.values()) {
      ranges.forEach(Object.freeze);
      Object.freeze(ranges);
    }
    const prepared = prepareCoinPolicyCapture(context, createEconomicDayCloseResolver(item.timeZoneId));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const result = prepared.value(subject(item.boardId as BoardId, item.logicalDate as LogicalDate));
    expect(result).toEqual({ ok: true, value: item.expected });
    if (!result.ok) throw new Error(result.error.message);
    expect(canonicalCoinPolicy(result.value)).toBe(item.expectedJson);
    expect(JSON.stringify(item)).toBe(before);
    if (item.capturedAtUtc !== undefined) {
      expect(currentLogicalDate(item.capturedAtUtc, item.timeZoneId, 240)).toBe(item.displayedRootDate);
    }
  });

  it('isolates an acquired snapshot from later in-memory edits and prepares prospective state explicitly', () => {
    const item = fixture.cases[2];
    const context = contextFrom(item);
    const prepared = prepareCoinPolicyCapture(context, createEconomicDayCloseResolver('UTC'));
    if (!prepared.ok) throw new Error(prepared.error.message);
    const before = prepared.value(subject(childId));
    const edited = context.boards.map((board) => ({ ...board }));
    edited[1].coinCapPerDay = 10;
    edited[1].anchorKind = null;
    edited[1].anchorRelation = null;
    edited[1].anchorBoardId = null;
    const future = prepareCoinPolicyCapture({ ...context, boards: edited }, createEconomicDayCloseResolver('UTC'));
    if (!future.ok) throw new Error(future.error.message);
    expect(future.value(subject(childId))).toMatchObject({ ok: true, value: { coinCapPerDay: 10, rootId: null, requiredBoardIds: [] } });
    const mutableBoard = context.boards[1] as { coinCapPerDay: number; anchorBoardId: BoardId | null };
    mutableBoard.coinCapPerDay = 1;
    mutableBoard.anchorBoardId = otherId;
    const mutablePeriod = context.periodsByBoard.get(childId)![0] as ActivityPeriodRange;
    mutablePeriod.endDate = date;
    expect(prepared.value(subject(childId))).toEqual(before);
  });

  it('reuses one topology derivation for multiple subjects and dates', () => {
    const derive = jest.spyOn(stacks, 'deriveStacks');
    try {
      const prepared = prepareCoinPolicyCapture(contextFrom(fixture.cases[2]), () => close);
      if (!prepared.ok) throw new Error(prepared.error.message);
      for (const boardId of [rootId, childId]) {
        for (const logicalDate of ['2026-09-07', '2026-09-08', '2026-09-09'] as LogicalDate[]) {
          expect(prepared.value(subject(boardId, logicalDate)).ok).toBe(true);
        }
      }
      expect(derive).toHaveBeenCalledTimes(1);
    } finally { derive.mockRestore(); }
  });

  it('ignores valid informational time, text, relation and home-order changes', () => {
    const context = contextFrom(fixture.cases[8]);
    const first = prepareCoinPolicyCapture(context, () => close);
    const edited = context.boards.map((board) => ({ ...board, usualTimeMinute: 1425, orderKey: 'different',
      anchorKind: 'text' as const, anchorPreset: null, anchorText: 'A different label', anchorRelation: 'before' as const }));
    const second = prepareCoinPolicyCapture({ ...context, boards: edited }, () => close);
    if (!first.ok || !second.ok) throw new Error('invalid test setup');
    expect(second.value(subject())).toEqual(first.value(subject()));
  });

  it.each([
    ['missing parent', { anchorKind: 'board', anchorRelation: 'after', anchorBoardId: otherId }],
    ['self cycle', { anchorKind: 'board', anchorRelation: 'after', anchorBoardId: rootId }],
    ['inconsistent flat target', { anchorBoardId: childId }],
    ['invalid shift', { startOfDayMinute: 1 }],
  ])('rejects %s before resolving calendar values', (_name, patch) => {
    const context = basicContext();
    const resolver = jest.fn(() => close);
    const result = prepareCoinPolicyCapture({ ...context, boards: [{ ...context.boards[0], ...patch } as CoinPolicyBoard] }, resolver);
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a deleted parent and a two-member cycle', () => {
    const context = contextFrom(fixture.cases[2]);
    expect(prepareCoinPolicyCapture({ ...context, boards: context.boards.map((board) => ({ ...board, deletedAt: board.id === rootId ? 1 : null })) }, () => close))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    const boards = context.boards.map((board) => board.id === rootId ? { ...board, anchorKind: 'board' as const, anchorRelation: 'after' as const, anchorBoardId: childId } : board);
    expect(prepareCoinPolicyCapture({ ...context, boards }, () => close)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('returns not_found for missing or deleted subjects', () => {
    const context = basicContext();
    const prepared = prepareCoinPolicyCapture({ ...context, boards: [{ ...context.boards[0], deletedAt: 1 }] }, () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject())).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(prepared.value(subject(otherId))).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it.each(['2026-02-30', 'not-a-date', undefined])('rejects an invalid stored date %s', (logicalDate) => {
    const prepared = prepareCoinPolicyCapture(basicContext(), () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value({ boardId: rootId, logicalDate: logicalDate as LogicalDate })).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each([undefined, 'not-an-id'])('rejects an invalid subject id %s before resolving closes', (boardId) => {
    const resolver = jest.fn(() => close);
    const prepared = prepareCoinPolicyCapture(basicContext(), resolver);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value({ boardId: boardId as BoardId, logicalDate: date })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, 0.5, -0, Number.MAX_SAFE_INTEGER + 1])('rejects invalid captured close %s', (invalid) => {
    const prepared = prepareCoinPolicyCapture(basicContext(), () => invalid);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject())).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('returns validation for calendar range failures and preserves unexpected resolver failures', () => {
    const range = prepareCoinPolicyCapture(basicContext(), () => { throw new RangeError('invalid zone'); });
    const unexpected = new Error('unavailable calendar dependency');
    const failure = prepareCoinPolicyCapture(basicContext(), () => { throw unexpected; });
    if (!range.ok || !failure.ok) throw new Error('invalid test setup');
    expect(range.value(subject())).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(() => failure.value(subject())).toThrow(unexpected);
  });

  it('validates the bonus close independently of the selected habit close', () => {
    const prepared = prepareCoinPolicyCapture(contextFrom(fixture.cases[2]), (_date, shift) => shift === 240 ? NaN : close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject(childId))).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it.each([{ kind: 'weekly' }, { earnsCoins: 1 }, { coinCapPerDay: 0 }, { coinCapPerDay: 11 }])('rejects invalid selected earning fields %s', (patch) => {
    const context = basicContext();
    const prepared = prepareCoinPolicyCapture({ ...context, boards: [{ ...context.boards[0], ...patch } as CoinPolicyBoard] }, () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject())).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('reports capacity for a valid component whose canonical policy exceeds the byte limit', () => {
    const base = basicContext().boards[0];
    const boards = [base, ...Array.from({ length: 5100 }, (_, index) => ({ ...base,
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` as BoardId,
      anchorKind: 'board' as const, anchorRelation: 'after' as const, anchorBoardId: rootId,
    }))];
    const periodsByBoard = new Map(boards.map((board) => [board.id, [{ startDate: date, endDate: null }]]));
    const prepared = prepareCoinPolicyCapture({ boards, periodsByBoard }, () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject())).toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
  });

  it.each([
    { startDate: undefined, endDate: null },
    { startDate: '2026-02-30', endDate: null },
    { startDate: date, endDate: undefined },
    { startDate: date, endDate: 'invalid' },
  ])('rejects malformed prospective period range %s before resolving closes', (range) => {
    const resolver = jest.fn(() => close);
    const result = prepareCoinPolicyCapture({ ...basicContext(), periodsByBoard: new Map([[rootId, [range as ActivityPeriodRange]]]) }, resolver);
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('preserves a valid-date reversed period as empty after a backward logical-day change', () => {
    const context = contextFrom(fixture.cases[8]);
    const prepared = prepareCoinPolicyCapture({ ...context,
      periodsByBoard: new Map([[rootId, [{ startDate: date, endDate: '2026-09-07' as LogicalDate }]]]),
    }, () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject())).toMatchObject({ ok: true, value: { rootId, requiredBoardIds: [], bonusEnabled: false } });
  });
});

describe('transaction-scoped policy capture reader', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); jest.restoreAllMocks(); });

  async function addBoard(title: string, anchorBoardId?: BoardId) {
    const result = await createBoard(h.deps, {
      commandId: h.ids.nextCommandId(), title, symbol: 'star.fill', accentHex: '#70A7FF',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      ...(anchorBoardId ? { anchor: { kind: 'board' as const, relation: 'after' as const, boardId: anchorBoardId } } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }

  it('reads metadata and only requested component periods once, reusing capture without writes', async () => {
    const root = await addBoard('Root');
    const child = await addBoard('Child', root);
    const outside = await addBoard('Unrelated');
    const statements: { sql: string; params: unknown }[] = [];
    await h.db.withExclusiveTransactionAsync(async (tx) => {
      const executor: SqlExecutor = {
        ...tx,
        runAsync: jest.fn(async () => { throw new Error('capture must not write'); }),
        getFirstAsync: jest.fn(async () => { throw new Error('capture must use bulk reads'); }),
        getAllAsync: async (sql, params) => { statements.push({ sql, params }); return tx.getAllAsync(sql, params); },
      };
      const prepared = await readCoinPolicyCapture(executor, [child, child], () => close);
      if (!prepared.ok) throw new Error(prepared.error.message);
      expect(prepared.value(subject(child))).toMatchObject({ ok: true, value: { rootId: root, requiredBoardIds: [root, child].sort() } });
      expect(prepared.value(subject(root))).toMatchObject({ ok: true, value: { rootId: root } });
      expect(prepared.value(subject(outside))).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(executor.runAsync).not.toHaveBeenCalled();
    });
    expect(statements).toHaveLength(2);
    expect(statements[1].sql).toContain('json_each(?)');
    expect(JSON.parse((statements[1].params as string[])[0]).sort()).toEqual([root, child].sort());
    expect(statements.every(({ sql }) => !/check_ins|habit_actions|coin_ledger|app_settings/i.test(sql))).toBe(true);
  });

  it('loads old and new target components together for prospective edits', async () => {
    const first = await addBoard('Old root');
    const moving = await addBoard('Moving', first);
    const second = await addBoard('New root');
    const prepared = await readCoinPolicyCapture(h.db, [moving, second], () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject(moving))).toMatchObject({ ok: true, value: { rootId: first } });
    expect(prepared.value(subject(second))).toMatchObject({ ok: true, value: { rootId: null } });
  });

  it('reads real archive gaps and reopened periods without including tombstoned periods', async () => {
    const root = await addBoard('Root');
    const child = await addBoard('Child', root);
    h.clock.advanceDays(2);
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    h.clock.advanceDays(2);
    expect((await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).ok).toBe(true);
    const prepared = await readCoinPolicyCapture(h.db, [root], () => close);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value(subject(child, '2026-08-31' as LogicalDate))).toMatchObject({ ok: true, value: { requiredBoardIds: [root, child].sort() } });
    expect(prepared.value(subject(child, '2026-09-01' as LogicalDate))).toMatchObject({ ok: true, value: { requiredBoardIds: [root] } });
    expect(prepared.value(subject(child, '2026-09-03' as LogicalDate))).toMatchObject({ ok: true, value: { requiredBoardIds: [root, child].sort() } });
    await h.db.runAsync('UPDATE board_activity_periods SET deleted_at = 1 WHERE board_id = ? AND end_date IS NULL', [child]);
    const missing = await readCoinPolicyCapture(h.db, [root], () => close);
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value(subject(child))).toMatchObject({ ok: true, value: { requiredBoardIds: [root] } });
    expect(prepared.value(subject(child))).toMatchObject({ ok: true, value: { requiredBoardIds: [root, child].sort() } });
  });

  it.each([undefined, 'not-an-id'])('rejects invalid requested id %s without reading the database', async (boardId) => {
    const getAllAsync = jest.fn();
    expect(await readCoinPolicyCapture({ getAllAsync } as unknown as SqlExecutor, [boardId as BoardId], () => close))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(getAllAsync).not.toHaveBeenCalled();
  });

  it('rejects malformed stored topology before reading period evidence', async () => {
    const root = await addBoard('Root');
    const child = await addBoard('Child', root);
    await h.db.runAsync('UPDATE boards SET deleted_at = 1 WHERE id = ?', [root]);
    const getAll = jest.spyOn(h.db, 'getAllAsync');
    expect(await readCoinPolicyCapture(h.db, [child], () => close)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('propagates a storage failure to the caller without a partial prepared context', async () => {
    const failure = new Error('sqlite read failed');
    const getAllAsync = jest.fn().mockRejectedValue(failure);
    await expect(readCoinPolicyCapture({ getAllAsync } as unknown as SqlExecutor, [rootId], () => close)).rejects.toBe(failure);
  });

  it('rejects malformed stored period evidence before preparing a capture', async () => {
    const root = await addBoard('Root');
    await h.db.runAsync('UPDATE board_activity_periods SET start_date = ? WHERE board_id = ?', ['invalid', root]);
    expect(await readCoinPolicyCapture(h.db, [root], () => close)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });

  it('does not query for an empty scope and rejects missing requested members before periods', async () => {
    const empty = await readCoinPolicyCapture({ getAllAsync: jest.fn() } as unknown as SqlExecutor, [], () => close);
    if (!empty.ok) throw new Error(empty.error.message);
    expect(empty.value(subject())).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await readCoinPolicyCapture(h.db, [rootId], () => close)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
