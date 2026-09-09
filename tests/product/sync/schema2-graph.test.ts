import { archiveBoard, deleteBoard, setICloudSyncEnabled, updateBoard } from '@/core/domain/commands';
import { createCheckIn } from '@/core/domain/check-in-commands';
import type { BoardId } from '@/core/domain/ids';
import { getStackListSnapshot } from '@/core/domain/stack-queries';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { runSync } from '@/core/sync/engine';
import { toSchema2SyncRecord } from '@/core/sync/schema-2-records';
import type { WireSyncRecord } from '@/core/sync/transport';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

let h: TestHarness;
let a: BoardId; let b: BoardId; let c: BoardId;
async function receive(records: WireSyncRecord[], token = 'next', options: { db?: SqlDatabase; shouldContinue?: () => boolean } = {}) {
  return runSync({ ...h.deps, ...options, random: () => 0, transport: {
    ensureZone: async () => {}, upload: async () => {},
    fetchChanges: async () => ({ records, nextToken: token, more: false }),
  } });
}
async function remote(id: BoardId, fields: Record<string, string | number | null> = {}, counter = 1) {
  const raw = await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM boards WHERE id = ?', [id]);
  if (!raw) throw Error('fixture board missing');
  const stamp = `${String(h.clock.utcMs + 3600000).padStart(14, '0')}-${counter.toString(36).padStart(5, '0')}-remote`;
  return toSchema2SyncRecord('board', id, stamp, { ...raw, ...fields });
}
const linked = (target: BoardId) => ({ anchor_kind: 'board', anchor_relation: 'after', anchor_board_id: target, anchor_preset: null, anchor_text: null });
const clear = { anchor_kind: null, anchor_relation: null, anchor_board_id: null, anchor_preset: null, anchor_text: null };
async function anchor(id: BoardId, target: BoardId) {
  const board = await getBoardById(h.db, id); if (!board) throw Error('fixture board missing');
  expect(await updateBoard(h.deps, { ...board, commandId: h.ids.nextCommandId(), boardId: id,
    expectedMutationStamp: board.mutationStamp, anchor: { kind: 'board', relation: 'after', boardId: target } })).toMatchObject({ ok: true });
  expect(await receive([], 'ready')).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
}
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger', 'remote_fact_inbox',
  'app_settings', 'mutation_outbox', 'command_receipts', 'widget_board_rows'];
async function snapshot() {
  return Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}
async function deferred() {
  const rows = await h.db.getAllAsync<{ payload: string }>('SELECT payload FROM sync_deferred ORDER BY entity_id');
  return rows.map(row => JSON.parse(row.payload) as WireSyncRecord);
}
beforeEach(async () => {
  h = await createTestHarness();
  a = await createBoardForTest(h, { title: 'A' }); b = await createBoardForTest(h, { title: 'B' }); c = await createBoardForTest(h, { title: 'C' });
  expect(await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true })).toMatchObject({ ok: true });
  expect(await receive([], 'ready')).toMatchObject({ ok: true });
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

describe('schema 2 strict raw board graph', () => {
  it('retains a cycle-producing winner without poisoning stack queries, HLC or unrelated commands', async () => {
    await anchor(a, b);
    const incoming = await remote(b, linked(a)); const before = await snapshot();
    expect(await receive([incoming], 'cycle')).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention', localChanged: true } });
    expect(await snapshot()).toEqual(before);
    expect(await deferred()).toEqual([incoming]);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'cycle' });
    for (let pass = 0; pass < 3; pass++) {
      expect(await receive([], `retry-${pass}`)).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention', localChanged: false } });
      expect(await deferred()).toEqual([incoming]);
      expect(await snapshot()).toEqual(before);
    }
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: c, source: 'app' })).toMatchObject({ ok: true });
  });

  it('rejects a live link to a retained deleted target while preserving the source tombstone', async () => {
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: b })).toMatchObject({ ok: true });
    await receive([], 'ready');
    const incoming = await remote(a, linked(b)); const before = await snapshot();
    expect(await receive([incoming])).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
    expect(await snapshot()).toEqual(before);
    expect(await deferred()).toEqual([incoming]);
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
  });

  it.each([false, true])('holds a parent deletion until its explicit dependent clear, same page=%s', async samePage => {
    await anchor(a, b);
    const tombstone = await remote(b, { deleted_at: h.clock.utcMs }); const cleared = await remote(a, clear, 2);
    const before = await snapshot();
    if (!samePage) {
      expect(await receive([tombstone], 'delete')).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
      expect(await snapshot()).toEqual(before);
      expect(await deferred()).toEqual([tombstone]);
    }
    expect(await receive(samePage ? [tombstone, cleared] : [cleared], 'clear')).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT anchor_board_id,mutation_stamp FROM boards WHERE id = ?', [a])).toEqual({ anchor_board_id: null, mutation_stamp: cleared.mutationStamp });
    expect(await h.db.getFirstAsync('SELECT deleted_at,mutation_stamp FROM boards WHERE id = ?', [b])).toEqual({ deleted_at: h.clock.utcMs, mutation_stamp: tombstone.mutationStamp });
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
  });

  it('retries a graph waiter after a non-immediate path node clears without rereading the graph or deferred table', async () => {
    await anchor(a, b); await anchor(c, a);
    const attach = await remote(b, linked(c)); const cleared = await remote(a, clear, 2);
    const reads: string[] = []; const getAll = h.db.getAllAsync.bind(h.db);
    jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) => { reads.push(sql); return getAll(sql, params); });
    expect(await receive([attach, cleared])).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT anchor_board_id FROM boards WHERE id = ?', [b])).toEqual({ anchor_board_id: c });
    expect(reads.filter(sql => sql.includes('SELECT entity_type, entity_id, mutation_stamp, payload FROM sync_deferred'))).toHaveLength(2);
    expect(reads.filter(sql => sql.startsWith('SELECT id, anchor_kind, anchor_board_id FROM boards'))).toHaveLength(1);
    expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
  });

  it.each(['older', 'equal'])('does not turn a %s cycle-forming loser into a graph problem', async age => {
    await anchor(b, a);
    const current = await getBoardById(h.db, a); if (!current) throw Error('fixture board missing');
    const incoming = { ...await remote(a, linked(b)), mutationStamp: age === 'equal' ? current.mutationStamp : '00000000000000-00000-remote' };
    const before = await snapshot();
    expect(await receive([incoming])).toMatchObject({ ok: true, value: { applied: 0, status: 'up_to_date' } });
    expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([]);
  });

  it.each(['sql', 'cancel'])('rolls back contextual deferral and actual graph changes after %s failure', async mode => {
    await anchor(a, b); await anchor(c, a);
    const records = [await remote(b, linked(c)), await remote(a, clear, 2)];
    const before = await snapshot(); let hit = false; let active = true;
    const db = Object.create(h.db) as SqlDatabase;
    db.withExclusiveTransactionAsync = work => h.db.withExclusiveTransactionAsync(tx => {
      const wrapped = Object.create(tx) as SqlExecutor;
      wrapped.runAsync = async (sql, params) => {
        const result = await tx.runAsync(sql, params);
        if (!hit && sql.startsWith('UPDATE boards SET')) {
          hit = true;
          if (mode === 'sql') throw Error('after actual graph write');
          active = false;
        }
        return result;
      };
      return work(wrapped);
    });
    expect(await receive(records, 'failed', { db, shouldContinue: () => active })).toMatchObject({ ok: true, value: { applied: 0, status: mode === 'sql' ? 'needs_attention' : 'idle' } });
    expect(hit).toBe(true); expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'ready' });
    expect(await receive(records, 'retry')).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
  });

  it('retains two all-new mutually anchored boards until a greater explicit root arrives', async () => {
    const x = h.ids.uuid() as BoardId; const y = h.ids.uuid() as BoardId;
    const left = await remote(a, { ...linked(y), id: x }); left.entityId = x;
    const right = await remote(b, { ...linked(x), id: y }); right.entityId = y;
    expect(await receive([left, right])).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
    expect(await deferred()).toEqual([left, right]);
    const root = { ...left, mutationStamp: left.mutationStamp.replace('00001', '00002'), fields: { ...left.fields, ...clear } };
    expect(await receive([root])).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]); expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
  });

  it('retains archived members in the structural graph', async () => {
    await anchor(a, b);
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: a })).toMatchObject({ ok: true });
    await receive([], 'ready');
    const cycle = await remote(b, linked(a)); const before = await snapshot();
    expect(await receive([cycle])).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
    expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([cycle]);
  });

  it.each([false, true])('keeps only the newest graph waiter and observes no stamp withheld by it, reversed=%s', async reverse => {
    await anchor(a, b);
    const older = await remote(b, linked(a), 1); const newer = await remote(b, { ...linked(a), title: 'newer graph candidate' }, 2);
    const before = await snapshot();
    const records = reverse ? [newer, older, newer] : [older, newer, newer];
    expect(await receive(records)).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
    expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([newer]);
    expect(await receive([await remote(a, clear, 3)])).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await h.db.getFirstAsync('SELECT title,mutation_stamp FROM boards WHERE id = ?', [b])).toEqual({ title: 'newer graph candidate', mutation_stamp: newer.mutationStamp });
  });

  it('does not observe an otherwise valid clear withheld by a newer retained graph candidate', async () => {
    await anchor(a, b);
    const newer = await remote(b, linked(a), 2);
    expect(await receive([newer])).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention' } });
    const before = await snapshot();
    expect(await receive([await remote(b, clear, 1)])).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention', localChanged: false } });
    expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([newer]);
    expect(await receive([await remote(b, clear, 3)])).toMatchObject({ ok: true, value: { applied: 1, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]);
  });

  it('holds deletion until every live dependent is explicitly detached', async () => {
    await anchor(a, b); await anchor(c, b);
    const tombstone = await remote(b, { deleted_at: h.clock.utcMs });
    expect(await receive([tombstone, await remote(a, clear, 2)])).toMatchObject({ ok: true, value: { applied: 1, status: 'needs_attention' } });
    expect(await deferred()).toEqual([tombstone]);
    expect(await getBoardById(h.db, b)).not.toBeNull();
    expect(await receive([await remote(c, clear, 3)])).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]);
  });

  it('retries a link when its retained deleted target becomes a live root through a greater remote version', async () => {
    const live = await remote(b, {}, 3);
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: b })).toMatchObject({ ok: true });
    await receive([], 'ready');
    const link = await remote(a, linked(b));
    expect(await receive([link, live])).toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(await deferred()).toEqual([]); expect(await getStackListSnapshot(h.deps)).toMatchObject({ ok: true });
  });

  it.each(['cycle', 'deleted target', 'missing target field'])('fails the page closed for an already corrupt stored graph: %s', async defect => {
    await h.db.runAsync('UPDATE boards SET anchor_kind = ?, anchor_relation = ?, anchor_board_id = ? WHERE id = ?',
      ['board', 'after', defect === 'missing target field' ? null : b, a]);
    if (defect === 'cycle') await h.db.runAsync('UPDATE boards SET anchor_kind = ?, anchor_relation = ?, anchor_board_id = ? WHERE id = ?', ['board', 'after', a, b]);
    if (defect === 'deleted target') await h.db.runAsync('UPDATE boards SET deleted_at = 1 WHERE id = ?', [b]);
    const before = await snapshot();
    expect(await receive([await remote(c, { title: 'must roll back' })], 'invalid-storage')).toMatchObject({ ok: true, value: { applied: 0, status: 'needs_attention', retryAfterMs: expect.any(Number) } });
    expect(await snapshot()).toEqual(before); expect(await deferred()).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'ready' });
  });
});
