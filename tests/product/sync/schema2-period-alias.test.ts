import { archiveBoard, deleteBoard, restoreBoard, setICloudSyncEnabled } from '@/core/domain/commands';
import type { BoardId } from '@/core/domain/ids';
import { runSync } from '@/core/sync/engine';
import { periodEntityId, toSyncRecord } from '@/core/sync/records';
import { toSchema2SyncRecord } from '@/core/sync/schema-2-records';
import type { SyncTransport, WireSyncRecord } from '@/core/sync/transport';

import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

type Period = { id: number; board_id: string; start_date: string; end_date: string | null;
  mutation_stamp: string; deleted_at: number | null };
let h: TestHarness;
let boardId: BoardId;
let controlId: BoardId;
const stamp = '01900000000000-00001-remote';

function transport(records: WireSyncRecord[] = [], token = 'ready'): SyncTransport<WireSyncRecord> {
  return { ensureZone: jest.fn(async () => {}), upload: jest.fn(async () => {}),
    fetchChanges: jest.fn(async () => ({ records, nextToken: token, more: false })) };
}
const sync = (remote: SyncTransport<WireSyncRecord>) => runSync({ ...h.deps, transport: remote, random: () => 0 });
const periods = () => h.db.getAllAsync<Period>('SELECT * FROM board_activity_periods WHERE board_id = ? ORDER BY id', [boardId]);
async function snapshot() {
  const tables = await h.db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sync_state' ORDER BY name");
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name,
    await h.db.getAllAsync(`SELECT * FROM ${name} ORDER BY rowid`)])));
}
const tokenState = () => h.db.getFirstAsync('SELECT change_token,zone_created,last_success_at FROM sync_state');

async function travelRestore(deleted: boolean) {
  h.clock.utcMs = Date.parse('2026-09-10T00:30:00Z');
  expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
  h.clock.utcMs = Date.parse('2026-09-10T01:00:00Z');
  h.clock.zone = 'Pacific/Honolulu';
  expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
  expect((await periods()).map(({ start_date, end_date }) => ({ start_date, end_date }))).toEqual([
    { start_date: '2026-09-09', end_date: '2026-09-10' }, { start_date: '2026-09-09', end_date: null },
  ]);
  if (deleted) {
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    expect((await periods()).every(row => row.deleted_at !== null)).toBe(true);
  }
}

beforeEach(async () => {
  h = await createTestHarness();
  h.clock.utcMs = Date.parse('2026-09-09T23:00:00Z'); h.clock.zone = 'UTC';
  boardId = await createBoardForTest(h, { title: 'travel period', kind: 'count' });
  controlId = await createBoardForTest(h, { title: 'protected control' });
  expect(await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true })).toMatchObject({ ok: true });
  expect(await sync(transport())).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

describe('period alias integrity through public sync', () => {
  it.each([false, true])('does not upload or acknowledge travel-created duplicate aliases, deleted=%s', async deleted => {
    await travelRestore(deleted);
    const before = await snapshot(); const priorToken = await tokenState(); const remote = transport();
    expect(await sync(remote)).toMatchObject({ ok: true, value: { status: 'needs_attention', uploaded: 0, applied: 0 } });
    expect(remote.ensureZone).not.toHaveBeenCalled();
    expect(remote.upload).not.toHaveBeenCalled();
    expect(remote.fetchChanges).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(await tokenState()).toEqual(priorToken);
  });

  it('reopens one interval for repeated ordinary same-zone same-day archive and restore', async () => {
    const original = (await periods())[0];
    for (let count = 0; count < 3; count++) {
      expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
      h.clock.advanceMinutes(1);
      expect(await restoreBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    }
    expect(await periods()).toEqual([{ ...original, mutation_stamp: (await periods())[0].mutation_stamp }]);
    let aliasReads = 0;
    const originalRead = h.db.getAllAsync.bind(h.db);
    jest.spyOn(h.db, 'getAllAsync').mockImplementation((sql, params) => {
      if (sql.includes('FROM board_activity_periods WHERE board_id = ? AND start_date = ? LIMIT 2') && params?.[0] === boardId) aliasReads++;
      return originalRead(sql, params);
    });
    const remote = transport();
    expect(await sync(remote)).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    const sent = jest.mocked(remote.upload).mock.calls.flatMap(([rows]) => rows)
      .filter(row => row.entityType === 'activity_period' && row.fields.board_id === boardId);
    expect(sent.length).toBeGreaterThan(0);
    expect(aliasReads).toBe(1);
    expect(sent.every(row => row.entityId === periodEntityId(boardId, '2026-09-09') && row.fields.end_date === null)).toBe(true);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
  });

  it.each([[1, false, false], [1, true, false], [2, false, false], [2, true, false], [2, false, true]] as const)(
    'rolls back a v%s page instead of choosing an ambiguous local row, deleted=%s invalid=%s', async (version, deleted, invalid) => {
      const priorToken = await tokenState();
      let before: Awaited<ReturnType<typeof snapshot>> | undefined;
      let earlierPageWrite = false;
      const originalRun = h.db.runAsync.bind(h.db);
      jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
        const result = await originalRun(sql, params);
        if (before && sql.startsWith('UPDATE boards SET') && params?.includes('remote page edit')) earlierPageWrite = true;
        return result;
      });
      const remote = transport();
      remote.fetchChanges = jest.fn(async () => {
        // these public edits commit while the network fetch is outstanding, after upload collection.
        await travelRestore(deleted);
        before = await snapshot();
        const control = await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM boards WHERE id = ?', [controlId]);
        const changed = toSchema2SyncRecord('board', controlId, stamp, { ...control, title: 'remote page edit' });
        const fields = { board_id: boardId, start_date: '2026-09-09', end_date: invalid ? 'bad-date' : '2026-09-11', deleted_at: null };
        const period = version === 1 ? toSyncRecord('activity_period', periodEntityId(boardId, fields.start_date), stamp, fields)
          : toSchema2SyncRecord('activity_period', periodEntityId(boardId, fields.start_date), stamp, fields);
        return { records: [period, changed], nextToken: 'must-not-commit', more: false };
      });
      expect(await sync(remote)).toMatchObject({ ok: true, value: { status: 'needs_attention', uploaded: 0, applied: 0, localChanged: false } });
      expect(earlierPageWrite).toBe(true);
      expect(remote.upload).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(await tokenState()).toEqual(priorToken);
    });

  it.each([1, 2] as const)('keeps zero/one-row alias insert, update, tombstone and exact replay working for v%s', async version => {
    const original = (await periods())[0];
    const changes = [
      { start_date: '2026-09-09', end_date: '2026-09-08', deleted_at: null },
      { start_date: '2026-09-10', end_date: null, deleted_at: null },
      { start_date: '2026-09-09', end_date: null, deleted_at: 1900000000000 },
      { start_date: '2026-09-09', end_date: '2026-09-10', deleted_at: null },
    ];
    for (const [index, change] of changes.entries()) {
      const fields = { board_id: boardId, ...change };
      const incomingStamp = `01900000000000-0000${index + 1}-remote`;
      const incoming = version === 1 ? toSyncRecord('activity_period', periodEntityId(boardId, fields.start_date), incomingStamp, fields)
        : toSchema2SyncRecord('activity_period', periodEntityId(boardId, fields.start_date), incomingStamp, fields);
      const remote = transport([incoming], `step-${index}`);
      expect(await sync(remote)).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 1 } });
      const found = (await periods()).filter(row => row.start_date === fields.start_date);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ ...fields, mutation_stamp: incomingStamp });
      if (fields.start_date === original.start_date) expect(found[0].id).toBe(original.id);
      const beforeReplay = await snapshot();
      expect(await sync(remote)).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 0 } });
      expect(await snapshot()).toEqual(beforeReplay);
      expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
      expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
    }
    expect(await periods()).toHaveLength(2);
  });
});
