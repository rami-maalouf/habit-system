import { archiveBoard, createBoard, createCheckIn, deleteBoard, restoreBoard, updateBoard, type CreateBoardInput } from '@/core/domain/commands';
import { parseCoinPolicy } from '@/core/domain/coin-policy';
import coinFixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { createBoardWithReminders } from '@/core/domain/create-board-with-reminders';
import type { BoardId, HabitActionId } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';

import { FakeReminderScheduler } from '../helpers/fake-scheduler';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const fields = {
  title: 'Coin settings', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
  tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
};
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger', 'mutation_outbox', 'app_settings', 'widget_board_rows'];
const snapshot = (h: TestHarness) => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
const invalid = [
  { earnsCoins: null }, { earnsCoins: 0 }, { earnsCoins: 'true' },
  { coinCapPerDay: null }, { coinCapPerDay: 0 }, { coinCapPerDay: 11 },
  { coinCapPerDay: 1.5 }, { coinCapPerDay: NaN }, { coinCapPerDay: Infinity }, { coinCapPerDay: '2' },
];

describe('board coin setting commands', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  async function create(extra: Partial<CreateBoardInput> = {}): Promise<BoardId> {
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...extra });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }

  async function update(boardId: BoardId, extra: Partial<CreateBoardInput> = {}) {
    const row = (await getBoardById(h.db, boardId))!;
    return updateBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), boardId,
      expectedMutationStamp: row.mutationStamp, ...extra });
  }

  async function policies() {
    const rows = await h.db.getAllAsync<{ board_id: BoardId; logical_date: string; mutation_stamp: string; policy_json: string }>(
      "SELECT board_id, logical_date, mutation_stamp, policy_json FROM habit_actions WHERE kind = 'policy' ORDER BY mutation_stamp, id");
    return rows.map(row => ({ boardId: row.board_id, date: row.logical_date, stamp: row.mutation_stamp, policy: parseCoinPolicy(row.policy_json) }));
  }

  it('defaults new habits to disabled cap one without an isolated creation policy', async () => {
    const id = await create();
    expect(await getBoardById(h.db, id)).toMatchObject({ earnsCoins: false, coinCapPerDay: 1 });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
  });

  it.each([1, 10])('persists explicit opt-in and cap %i through create and an omitted update', async cap => {
    const id = await create({ earnsCoins: true, coinCapPerDay: cap });
    expect(await getBoardById(h.db, id)).toMatchObject({ earnsCoins: true, coinCapPerDay: cap });
    expect(await update(id, { title: 'Renamed' })).toMatchObject({ ok: true });
    expect(await getBoardById(h.db, id)).toMatchObject({ title: 'Renamed', earnsCoins: true, coinCapPerDay: cap });
  });

  it.each(invalid)('rejects invalid create fields before any domain writes: %j', async bad => {
    const before = await snapshot(h);
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), earnsCoins: false,
      ...bad } as unknown as CreateBoardInput);
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h)).toEqual(before);
  });

  it.each(invalid)('rejects invalid update fields while disabled: %j', async bad => {
    const id = await create();
    const before = await snapshot(h);
    expect(await update(id, bad as unknown as Partial<CreateBoardInput>)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h)).toEqual(before);
  });

  it('changes earning settings prospectively without rewarding or rewriting retained checks', async () => {
    const id = await create();
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app', note: 'before opt-in' })).toMatchObject({ ok: true });
    const checks = await h.db.getAllAsync('SELECT * FROM check_ins');
    expect(await update(id, { earnsCoins: true, coinCapPerDay: 10 })).toMatchObject({ ok: true });
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual(checks);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app' })).toMatchObject({ ok: true });
    const earned = await h.db.getAllAsync('SELECT * FROM coin_ledger');
    expect(earned).toHaveLength(1);
    expect(await update(id, { earnsCoins: false, coinCapPerDay: 1 })).toMatchObject({ ok: true });
    expect(await getBoardById(h.db, id)).toMatchObject({ earnsCoins: false, coinCapPerDay: 1 });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual(earned);
  });

  it('uses the same validation and defaults for reminder-aware creation', async () => {
    const scheduler = new FakeReminderScheduler();
    scheduler.auth = 'undetermined';
    const deps = { ...h.deps, scheduler };
    const input = { ...fields, commandId: h.ids.nextCommandId(), earnsCoins: true, coinCapPerDay: 3,
      reminders: [{ weekdaysMask: 1, minuteOfDay: 540, enabled: true }] };
    expect(await createBoardWithReminders(deps, { ...input, coinCapPerDay: null } as unknown as typeof input))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(scheduler.prompts).toBe(0);
    expect(await h.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
    const result = await createBoardWithReminders(deps, { ...input, commandId: h.ids.nextCommandId() });
    if (!result.ok) throw new Error(result.error.message);
    expect(await getBoardById(h.db, result.value.boardId)).toMatchObject({ earnsCoins: true, coinCapPerDay: 3 });
    expect(scheduler.pending.size).toBe(1);
  });

  it('records root-carried membership while keeping structural identity separate from display order', async () => {
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    expect(await policies()).toMatchObject([{ boardId: root, policy: { rootId: root, requiredBoardIds: [root] } }]);
    const child = await create({ anchor: { kind: 'board', relation: 'before', boardId: root } });
    expect((await policies()).at(-1)).toMatchObject({ boardId: root, policy: { rootId: root, requiredBoardIds: [root, child].sort() } });
    const before = await policies();
    expect(await update(child, { title: 'Informational only', usualTimeMinute: 0 })).toMatchObject({ ok: true });
    expect(await policies()).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('moves a subtree between two remaining roots without retiring either root', async () => {
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const other = await create({ anchor: { kind: 'text', relation: 'after', text: 'Dinner' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    const grandchild = await create({ anchor: { kind: 'board', relation: 'after', boardId: child } });
    const before = (await policies()).length;
    expect(await update(child, { anchor: { kind: 'board', relation: 'after', boardId: other } })).toMatchObject({ ok: true });
    expect((await policies()).slice(before)).toMatchObject([
      { boardId: root, policy: { rootId: root, requiredBoardIds: [root], bonusEnabled: true } },
      { boardId: other, policy: { rootId: other, requiredBoardIds: [other, child, grandchild].sort(), bonusEnabled: true } },
    ]);
  });

  it('captures both exact dates at different root/member shifts and only changes the archived date', async () => {
    h.clock.utcMs = Date.parse('2026-09-07T12:00:00Z'); h.clock.zone = 'UTC';
    const root = await create({ startOfDayMinute: 240, anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    h.clock.utcMs = Date.parse('2026-09-08T02:00:00Z');
    const before = (await policies()).length;
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).toMatchObject({ ok: true });
    expect((await policies()).slice(before)).toMatchObject([
      { boardId: root, date: '2026-09-08', policy: { requiredBoardIds: [root] } },
    ]);
    expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).toMatchObject({ ok: true });
    expect((await policies()).at(-1)).toMatchObject({ boardId: root, date: '2026-09-08', policy: { requiredBoardIds: [root, child].sort() } });
    const shifted = (await policies()).length;
    expect(await update(root, { startOfDayMinute: 0 })).toMatchObject({ ok: true });
    expect((await policies()).slice(shifted).map(row => row.date)).toEqual(['2026-09-07', '2026-09-08']);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('retires a deleted structural root before recording its surviving child stack', async () => {
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    const isolated = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    const grandchild = await create({ anchor: { kind: 'board', relation: 'after', boardId: child } });
    const before = (await policies()).length;
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    const emitted = (await policies()).slice(before);
    expect(emitted).toMatchObject([
      { boardId: root, policy: { rootId: root, requiredBoardIds: [root, child, isolated, grandchild].sort(), bonusEnabled: false } },
      { boardId: child, policy: { rootId: child, requiredBoardIds: [child, grandchild].sort(), bonusEnabled: true } },
    ]);
    expect(emitted[0].stamp < emitted[1].stamp).toBe(true);
  });

  it('rolls back a failed policy append and replays a later successful retry before input validation', async () => {
    const id = await create();
    const row = (await getBoardById(h.db, id))!;
    const input = { ...fields, commandId: h.ids.nextCommandId(), boardId: id, expectedMutationStamp: row.mutationStamp, earnsCoins: true };
    const before = await snapshot(h);
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts');
    const run = h.db.runAsync.bind(h.db);
    const fail = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => sql.includes('INSERT INTO habit_actions')
      ? Promise.reject(new Error('policy storage failed')) : run(sql, params));
    expect(await updateBoard(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
    fail.mockRestore();
    const result = await updateBoard(h.deps, input);
    expect(result).toMatchObject({ ok: true });
    const after = await snapshot(h);
    expect(await updateBoard(h.deps, { ...input, title: '', coinCapPerDay: 99 })).toEqual(result);
    expect(await snapshot(h)).toEqual(after);
  });

  it.each(['create', 'update', 'archive', 'restore', 'delete'])('validates copied period state before any %s write', async operation => {
    const id = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    if (operation === 'restore') expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id })).toMatchObject({ ok: true });
    await h.db.runAsync("UPDATE board_activity_periods SET start_date = 'invalid' WHERE board_id = ?", [id]);
    const before = await snapshot(h);
    const result = operation === 'create'
      ? await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board', relation: 'after', boardId: id } })
      : operation === 'update' ? await update(id, { kind: 'daily' })
      : operation === 'archive' ? await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id })
      : operation === 'restore' ? await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id })
      : await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h)).toEqual(before);
  });

  it('rejects a malformed inherited component before emitting any prospective facts', async () => {
    const id = await create();
    const invalid = await create();
    await h.db.runAsync("UPDATE boards SET anchor_kind = 'board', anchor_relation = 'after', anchor_board_id = id WHERE id = ?", [invalid]);
    const before = await snapshot(h);
    expect(await update(id, { earnsCoins: true })).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h)).toEqual(before);
  });

  it('requires missing bonus source evidence before committing a policy-changing command', async () => {
    const id = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const bonus = coinFixture.shapeRows.find(row => row.kind === 'run_bonus')! as CoinLedgerRow;
    await appendLedgerEntry(h.db, { ...bonus, runKey: `${id}|${bonus.logicalDate}`, scopeKey: `bonus:${id}:${bonus.logicalDate}`,
      sourceActionId: '00000000-0000-4000-8000-000000009999' as HabitActionId });
    const before = await snapshot(h);
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts');
    expect(await update(id, { earnsCoins: true })).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
  });

  it('uses sparse captured open dates after a real clock rollback while excluding unrelated history', async () => {
    h.clock.utcMs = Date.parse('2026-09-20T12:00:00Z'); h.clock.zone = 'UTC';
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: child, source: 'app' })).toMatchObject({ ok: true });
    h.clock.advanceDays(1);
    const unrelated = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'sleep' } });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: unrelated, source: 'app' })).toMatchObject({ ok: true });
    h.clock.utcMs = Date.parse('2026-09-08T12:00:00Z');
    const before = (await policies()).length;
    const checks = await h.db.getAllAsync('SELECT * FROM check_ins');
    const reads = jest.spyOn(h.db, 'getAllAsync');
    expect(await update(child, { requiredInStack: false })).toMatchObject({ ok: true });
    const economicReads = reads.mock.calls.filter(([sql]) => /FROM (habit_actions|coin_ledger|json_each)/.test(sql));
    const emitted = (await policies()).slice(before);
    expect(emitted.map(row => [row.boardId, row.date])).toEqual([[root, '2026-09-20']]);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual(checks);
    // complete check and bonus settlement uses a fixed bulk read set.
    expect(economicReads.length).toBeLessThanOrEqual(12);
    expect(economicReads.every(([sql]) => !sql.includes('note') && !sql.includes('amount'))).toBe(true);
  });

  it.each(['mutation_outbox', 'widget_board_rows', 'command_receipts'])('rolls back all archive effects when %s storage fails', async table => {
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    const child = await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    const before = await snapshot(h);
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts');
    const input = { commandId: h.ids.nextCommandId(), boardId: child };
    const run = h.db.runAsync.bind(h.db);
    const fail = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => {
      const matches = table === 'widget_board_rows' ? sql.includes('DELETE FROM widget_board_rows') : sql.includes(`INSERT INTO ${table}`);
      return matches ? Promise.reject(new Error('policy transaction storage failed')) : run(sql, params);
    });
    expect(await archiveBoard(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
    fail.mockRestore();
    expect(await archiveBoard(h.deps, input)).toMatchObject({ ok: true });
    expect((await policies()).at(-1)).toMatchObject({ policy: { requiredBoardIds: [root] } });
  });

  it('leaves previously closed periods intact while archiving a later restored period', async () => {
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    h.clock.advanceDays(1);
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    const first = await h.db.getFirstAsync('SELECT * FROM board_activity_periods WHERE board_id = ?', [root]);
    h.clock.advanceDays(1);
    expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    h.clock.advanceDays(1);
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root })).toMatchObject({ ok: true });
    const periods = await h.db.getAllAsync('SELECT * FROM board_activity_periods WHERE board_id = ? ORDER BY id', [root]);
    expect(periods[0]).toEqual(first);
    expect(periods[1]).toMatchObject({ start_date: '2026-09-01', end_date: '2026-09-02' });
  });

  it('uses a bounded bulk read set for a wide component with many captured open dates', async () => {
    h.clock.utcMs = Date.parse('2026-09-01T12:00:00Z'); h.clock.zone = 'UTC';
    const root = await create({ anchor: { kind: 'preset', relation: 'after', preset: 'wake' } });
    for (let index = 0; index < 32; index += 1) {
      await create({ anchor: { kind: 'board', relation: 'after', boardId: root } });
    }
    for (let index = 0; index < 20; index += 1) {
      expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root, source: 'app' })).toMatchObject({ ok: true });
      h.clock.advanceDays(1);
    }
    h.clock.utcMs = Date.parse('2026-09-01T12:00:00Z');
    const before = (await policies()).length;
    const reads = jest.spyOn(h.db, 'getAllAsync');
    expect(await update(root, { requiredInStack: false })).toMatchObject({ ok: true });
    const economicReads = reads.mock.calls.filter(([sql]) => /FROM (habit_actions|coin_ledger|json_each)/.test(sql));
    // 33 members across 20 dates use the same read budget as the small case.
    expect(economicReads.length).toBeLessThanOrEqual(12);
    const emitted = (await policies()).slice(before);
    expect(emitted).toHaveLength(20);
    expect(new Set(emitted.map(row => row.date)).size).toBe(20);
    expect(emitted.every(row => row.boardId === root && row.policy.requiredBoardIds.length === 32)).toBe(true);
  });
});
