import {
  archiveBoard,
  createBoard,
  createCheckIn,
  toggleDailyCheckIn,
  updateBoard,
} from '@/core/domain/commands';
import { runCheckInIntent, runRemoveLatestIntent } from '@/core/automations/contract';
import type { BoardId } from '@/core/domain/ids';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { appendOutbox, listOutbox } from '@/core/persistence/repositories/support';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const boardFields = {
  title: 'atomic daily habit', symbol: 'star.fill', accentHex: '#78D98B',
  usesTintedBackground: false, tracksAmount: false, tracksTime: false,
  startOfDayMinute: 0, metricsEnabled: true,
};

async function create(h: TestHarness, kind: 'daily' | 'count'): Promise<BoardId> {
  const result = await createBoard(h.deps, {
    ...boardFields, kind, commandId: h.ids.nextCommandId(),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function snapshot(db: SqlExecutor) {
  const tables = [
    'boards', 'check_ins', 'habit_actions', 'command_receipts',
    'app_settings', 'widget_board_rows', 'mutation_outbox',
  ];
  const rows = await Promise.all(tables.map((table) => db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
}

function failingAt(db: SqlDatabase, statement: string): SqlDatabase {
  const wrapped = Object.create(db) as SqlDatabase;
  wrapped.withExclusiveTransactionAsync = (work) => db.withExclusiveTransactionAsync((tx) => {
    const failing = Object.create(tx) as SqlExecutor;
    failing.runAsync = (sql, params) => {
      if (sql.includes(statement)) throw new Error('injected storage failure');
      return tx.runAsync(sql, params);
    };
    return work(failing);
  });
  return wrapped;
}

describe('daily transaction atomicity', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it.each(['INSERT INTO habit_actions', 'INSERT INTO command_receipts'])(
    'rolls back a new completion when %s fails, then retries safely', async (statement) => {
      const boardId = await create(h, 'daily');
      const before = await snapshot(h.db);
      const commandId = h.ids.nextCommandId();
      const input = { commandId, boardId };
      const failed = await toggleDailyCheckIn({ ...h.deps, db: failingAt(h.db, statement) }, input);
      expect(failed).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
      expect(await snapshot(h.db)).toEqual(before);
      const retried = await toggleDailyCheckIn(h.deps, input);
      expect(retried).toMatchObject({ ok: true, value: { checked: true, created: true } });
      expect(await toggleDailyCheckIn(h.deps, input)).toEqual(retried);
      expect(await h.db.getAllAsync('SELECT id FROM check_ins WHERE deleted_at IS NULL')).toHaveLength(1);
      expect(await h.db.getAllAsync("SELECT id FROM habit_actions WHERE kind = 'check'")).toHaveLength(1);
    },
  );

  it('restores every retained check and note when a whole-day removal fails at receipt persistence', async () => {
    const boardId = await create(h, 'count');
    const retainedIds: string[] = [];
    for (const note of ['first retained note', 'second retained note']) {
      const result = await createCheckIn(h.deps, {
        commandId: h.ids.nextCommandId(), boardId, source: 'app', note,
      });
      if (!result.ok) throw new Error(result.error.message);
      retainedIds.push(result.value.checkInId);
    }
    const board = await getBoardById(h.db, boardId);
    if (!board) throw new Error('missing board');
    expect(await updateBoard(h.deps, {
      ...boardFields, kind: 'daily', commandId: h.ids.nextCommandId(),
      boardId, expectedMutationStamp: board.mutationStamp,
    })).toMatchObject({ ok: true });
    const before = await snapshot(h.db);
    const input = { commandId: h.ids.nextCommandId(), boardId };
    expect(await toggleDailyCheckIn({
      ...h.deps, db: failingAt(h.db, 'INSERT INTO command_receipts'),
    }, input)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h.db)).toEqual(before);
    expect(await toggleDailyCheckIn(h.deps, input)).toMatchObject({
      ok: true, value: { checked: false, removedCheckInIds: retainedIds },
    });
    expect(await h.db.getAllAsync('SELECT id FROM check_ins WHERE deleted_at IS NULL')).toEqual([]);
    expect(await h.db.getAllAsync("SELECT check_in_id FROM habit_actions WHERE kind = 'uncheck'"))
      .toEqual([{ check_in_id: null }]);
  });

  it.each(['habit_action', 'ledger_entry', 'reward'] as const)('keeps staged %s rows pending without starving supported uploads behind them', async (entityType) => {
    const boardId = await create(h, 'daily');
    const board = await getBoardById(h.db, boardId);
    if (!board) throw new Error('missing board');
    await h.db.runAsync('DELETE FROM mutation_outbox');
    for (let index = 0; index < 205; index += 1) {
      await appendOutbox(h.db, entityType, h.ids.uuid(), board.mutationStamp, h.clock.utcMs);
    }
    await appendOutbox(h.db, 'board', boardId, board.mutationStamp, h.clock.utcMs);
    expect(await listOutbox(h.db, 1)).toEqual([{
      id: expect.any(Number), entityType: 'board', entityId: boardId, mutationStamp: board.mutationStamp,
    }]);
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM mutation_outbox WHERE entity_type = ?', [entityType]))
      .toEqual({ count: 205 });
  });

  it.each(['check', 'remove'] as const)(
    'replays an acknowledged automation %s after the board is archived', async (operation) => {
      const boardId = await create(h, 'daily');
      if (operation === 'remove') {
        expect(await toggleDailyCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId }))
          .toMatchObject({ ok: true });
      }
      const input = { commandId: h.ids.nextCommandId(), boardId, source: 'shortcut' as const };
      const run = () => operation === 'check'
        ? runCheckInIntent(h.deps, input)
        : runRemoveLatestIntent(h.deps, input);
      const first = await run();
      expect(first).toMatchObject({ ok: true });
      expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }))
        .toMatchObject({ ok: true });
      const before = await snapshot(h.db);
      expect(await run()).toEqual(first);
      expect(await snapshot(h.db)).toEqual(before);
    },
  );
});
