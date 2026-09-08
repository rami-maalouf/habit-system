import {
  archiveBoard, createBoard, createCheckIn, deleteBoard, restoreBoard, type CreateBoardInput,
} from '@/core/domain/commands';
import { createBoardWithReminders } from '@/core/domain/create-board-with-reminders';
import type { Board } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';
import { getBoardDependentCounts } from '@/core/domain/queries';
import { getBoardById } from '@/core/persistence/repositories/boards';

import { FakeReminderScheduler } from '../helpers/fake-scheduler';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const fields = {
  title: 'Stack member', symbol: 'star.fill', accentHex: '#70A7FF',
  usesTintedBackground: true, tracksAmount: true, amountUnit: 'pages', quickAmount: 3,
  tracksTime: true, startOfDayMinute: 0, metricsEnabled: false,
  usualTimeMinute: 1425, requiredInStack: false,
};
const noAnchor = { anchorRelation: null, anchorKind: null, anchorBoardId: null, anchorPreset: null, anchorText: null };
const tables = ['boards', 'check_ins', 'habit_actions', 'board_activity_periods', 'reminders', 'app_settings', 'mutation_outbox', 'widget_board_rows', 'command_receipts'];

async function snapshot(h: TestHarness) {
  return Promise.all(tables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

describe('deleting anchor boards', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  async function create(extra: Partial<CreateBoardInput> = {}): Promise<Board> {
    const result = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...extra });
    if (!result.ok) throw new Error(result.error.message);
    return (await getBoardById(h.db, result.value.boardId))!;
  }

  async function dependent(boardId: BoardId, archived = false): Promise<Board> {
    const result = await createBoardWithReminders({ ...h.deps, scheduler: new FakeReminderScheduler() }, {
      ...fields, commandId: h.ids.nextCommandId(), anchor: { kind: 'board', relation: 'before', boardId },
      reminders: [{ weekdaysMask: 1, minuteOfDay: 540, enabled: true, message: 'kept reminder' }],
    });
    if (!result.ok) throw new Error(result.error.message);
    const id = result.value.boardId;
    expect((await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: id, source: 'app', amount: 7, note: 'kept note', occurredAtUtc: h.clock.utcMs })).ok).toBe(true);
    if (archived) expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: id })).ok).toBe(true);
    return (await getBoardById(h.db, id))!;
  }

  async function tree() {
    const root = await create();
    const active = await dependent(root.id);
    const archived = await dependent(root.id, true);
    const grandchild = await create({ anchor: { kind: 'board', relation: 'after', boardId: active.id } });
    const deleted = await create({ anchor: { kind: 'board', relation: 'after', boardId: root.id } });
    await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: deleted.id });
    return { root, active, archived, grandchild, deleted };
  }

  it('reports and clears only direct active and archived links while retaining every dependent history row', async () => {
    const { root, active, archived, grandchild, deleted } = await tree();
    expect(await getBoardDependentCounts(h.deps, root.id)).toEqual({ ok: true, value: { checkIns: 0, notes: 0, reminders: 0, anchoredBoards: 2 } });
    const historyTables = ['check_ins', 'habit_actions', 'reminders', 'board_activity_periods'];
    const history = await Promise.all(historyTables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} WHERE board_id IN (?, ?) ORDER BY rowid`, [active.id, archived.id])));
    const tombstone = await h.db.getFirstAsync('SELECT * FROM boards WHERE id = ?', [deleted.id]);
    const outboxBefore = (await h.db.getAllAsync('SELECT id FROM mutation_outbox')).length;
    h.clock.advanceMinutes(15);
    const commandId = h.ids.nextCommandId();
    expect(await deleteBoard(h.deps, { commandId, boardId: root.id })).toEqual({ ok: true, value: undefined });
    const cleared = (await getBoardById(h.db, active.id))!;
    expect(cleared).toEqual({ ...active, ...noAnchor, updatedAt: h.clock.utcMs, mutationStamp: cleared.mutationStamp });
    expect(cleared.mutationStamp).not.toBe(active.mutationStamp);
    expect(await getBoardById(h.db, archived.id)).toEqual({ ...archived, ...noAnchor, updatedAt: h.clock.utcMs, mutationStamp: cleared.mutationStamp });
    expect(await getBoardById(h.db, grandchild.id)).toEqual(grandchild);
    expect(await h.db.getFirstAsync('SELECT * FROM boards WHERE id = ?', [deleted.id])).toEqual(tombstone);
    expect(await getBoardById(h.db, root.id)).toBeNull();
    expect(await Promise.all(historyTables.map((table) => h.db.getAllAsync(`SELECT * FROM ${table} WHERE board_id IN (?, ?) ORDER BY rowid`, [active.id, archived.id])))).toEqual(history);
    const added = (await h.db.getAllAsync<{ entity_type: string; entity_id: string; mutation_stamp: string; created_at: number }>('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox ORDER BY id')).slice(outboxBefore);
    expect(added.filter((row) => row.entity_type === 'board')).toEqual([active.id, archived.id, root.id].map((entity_id) => ({ entity_type: 'board', entity_id, mutation_stamp: cleared.mutationStamp, created_at: h.clock.utcMs })));
    expect(await getBoardDependentCounts(h.deps, root.id)).toMatchObject({ ok: true, value: { anchoredBoards: 0 } });
    const committed = await snapshot(h);
    expect(await deleteBoard(h.deps, { commandId, boardId: root.id })).toEqual({ ok: true, value: undefined });
    expect(await snapshot(h)).toEqual(committed);
  });

  it('clears the children of an internal member without changing its root or siblings', async () => {
    const { root, active, archived, grandchild } = await tree();
    expect((await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: active.id })).ok).toBe(true);
    expect(await getBoardById(h.db, root.id)).toEqual(root);
    expect(await getBoardById(h.db, archived.id)).toEqual(archived);
    expect(await getBoardById(h.db, grandchild.id)).toMatchObject({ ...noAnchor, usualTimeMinute: 1425, requiredInStack: false });
  });

  it('archive and restore do not clear or stamp dependents', async () => {
    const { root, active, archived } = await tree();
    const before = await h.db.getAllAsync('SELECT * FROM mutation_outbox WHERE entity_type = ? AND entity_id IN (?, ?)', ['board', active.id, archived.id]);
    expect((await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root.id })).ok).toBe(true);
    expect((await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: root.id })).ok).toBe(true);
    expect(await getBoardById(h.db, active.id)).toEqual(active);
    expect(await getBoardById(h.db, archived.id)).toEqual(archived);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox WHERE entity_type = ? AND entity_id IN (?, ?)', ['board', active.id, archived.id])).toEqual(before);
  });

  it.each(['dependent', 'outbox', 'receipt'] as const)('rolls back the whole cleanup after a %s write fails and safely retries once', async (failure) => {
    const { root, active, archived } = await tree();
    expect((await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root.id, source: 'app', note: 'owned root note' })).ok).toBe(true);
    const commandId = h.ids.nextCommandId();
    const before = await snapshot(h);
    const target = failure === 'dependent' ? `BEFORE UPDATE ON boards WHEN OLD.id = '${archived.id}'`
      : failure === 'outbox' ? `BEFORE INSERT ON mutation_outbox WHEN NEW.entity_type = 'board' AND NEW.entity_id = '${archived.id}'`
      : 'BEFORE INSERT ON command_receipts';
    await h.db.execAsync(`CREATE TRIGGER fail_cleanup ${target} BEGIN SELECT RAISE(ABORT, 'injected anchor cleanup failure'); END;`);
    expect(await deleteBoard(h.deps, { commandId, boardId: root.id })).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h)).toEqual(before);
    await h.db.execAsync('DROP TRIGGER fail_cleanup');
    expect((await deleteBoard(h.deps, { commandId, boardId: root.id })).ok).toBe(true);
    expect(await getBoardById(h.db, active.id)).toMatchObject(noAnchor);
    expect(await getBoardById(h.db, archived.id)).toMatchObject(noAnchor);
    const committed = await snapshot(h);
    expect((await deleteBoard(h.deps, { commandId, boardId: root.id })).ok).toBe(true);
    expect(await snapshot(h)).toEqual(committed);
  });
});
