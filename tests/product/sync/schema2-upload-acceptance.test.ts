import { createCheckIn, setICloudSyncEnabled, updateBoard } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoard } from '@/core/domain/queries';
import { runSync } from '@/core/sync/engine';
import { SyncTransportError, type SyncRecord, type SyncTransport } from '@/core/sync/transport';

import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function enable(harness: TestHarness) {
  expect(await setICloudSyncEnabled(harness.deps, {
    commandId: harness.ids.nextCommandId(), enabled: true,
  })).toMatchObject({ ok: true });
}

async function rename(harness: TestHarness, boardId: BoardId, title: string) {
  const board = await getBoard(harness.deps, boardId);
  if (!board.ok || !board.value) throw new Error('missing test board');
  expect(await updateBoard(harness.deps, {
    ...board.value, commandId: harness.ids.nextCommandId(), boardId,
    expectedMutationStamp: board.value.mutationStamp, title,
  })).toMatchObject({ ok: true });
}

function deps(harness: TestHarness, transport: SyncTransport) {
  return { db: harness.db, clock: harness.clock, hashing: harness.deps.hashing,
    transport, random: () => 0.5 };
}

const emptyPage = async () => ({ records: [], nextToken: 'empty', more: false });

describe('independent public schema-2 upload acceptance', () => {
  it('pairs every queued board upload with its current source stamp and current fields', async () => {
    const h = await createTestHarness();
    try {
      await enable(h);
      const boardId = await createBoardForTest(h, { title: 'original', kind: 'daily', earnsCoins: true });
      await rename(h, boardId, 'intermediate');
      await rename(h, boardId, 'latest');
      const queued = await h.db.getAllAsync<{ mutation_stamp: string }>(
        'SELECT mutation_stamp FROM mutation_outbox WHERE entity_type = ? AND entity_id = ?', ['board', boardId]);
      expect(new Set(queued.map(row => row.mutation_stamp)).size).toBe(3);
      const current = await h.db.getFirstAsync<{ mutation_stamp: string }>(
        'SELECT mutation_stamp FROM boards WHERE id = ?', [boardId]);
      const uploads: SyncRecord[] = [];
      const transport: SyncTransport = { ensureZone: async () => {}, fetchChanges: emptyPage,
        upload: async records => { uploads.push(...records); } };
      expect(await runSync(deps(h, transport))).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
      const sent = uploads.filter(record => record.entityType === 'board' && record.entityId === boardId);
      expect(sent.length).toBeGreaterThan(0);
      for (const record of sent) {
        expect(record.mutationStamp).toBe(current?.mutation_stamp);
        expect(record).toMatchObject({ schemaVersion: 2, fields: { title: 'latest', kind: 'daily', earns_coins: 1 } });
      }
      expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
    } finally { await h.db.closeAsync(); }
  });

  it('acknowledges only the selected queue ids when a real edit commits during upload', async () => {
    const h = await createTestHarness();
    const started = deferred(); const release = deferred();
    try {
      await enable(h);
      const boardId = await createBoardForTest(h, { title: 'before upload' });
      const selected = await h.db.getAllAsync<{ id: number }>('SELECT id FROM mutation_outbox ORDER BY id');
      const first: SyncRecord[] = []; let calls = 0;
      const transport: SyncTransport = { ensureZone: async () => {}, fetchChanges: emptyPage,
        upload: async records => {
          calls += 1;
          if (calls > 1) throw new SyncTransportError('offline', 'test connection stopped');
          first.push(...records); started.resolve(); await release.promise;
        } };
      const running = runSync(deps(h, transport));
      await started.promise;
      await rename(h, boardId, 'edited while uploading');
      const latest = await h.db.getFirstAsync<{ mutation_stamp: string }>(
        'SELECT mutation_stamp FROM boards WHERE id = ?', [boardId]);
      const added = await h.db.getAllAsync<{ id: number; mutation_stamp: string }>(
        'SELECT id, mutation_stamp FROM mutation_outbox WHERE id > ? ORDER BY id', [Math.max(...selected.map(row => row.id))]);
      expect(added.length).toBeGreaterThan(0);
      release.resolve();
      expect(await running).toMatchObject({ ok: true, value: { status: 'offline' } });
      const remaining = await h.db.getAllAsync<{ id: number; mutation_stamp: string }>(
        'SELECT id, mutation_stamp FROM mutation_outbox ORDER BY id');
      expect(remaining).toEqual(added);
      expect(first.find(record => record.entityType === 'board')).toMatchObject({
        fields: { title: 'before upload' },
      });
      const retry: SyncRecord[] = [];
      transport.upload = async records => { retry.push(...records); };
      expect(await runSync(deps(h, transport))).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
      expect(retry.find(record => record.entityType === 'board')).toMatchObject({
        schemaVersion: 2, mutationStamp: latest?.mutation_stamp, fields: { title: 'edited while uploading' },
      });
      expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
    } finally { release.resolve(); await h.db.closeAsync(); }
  });

  it('retains the exact batch and immutable bytes when native immutable comparison refuses upload', async () => {
    const h = await createTestHarness();
    try {
      await enable(h);
      const boardId = await createBoardForTest(h, { kind: 'daily', earnsCoins: true });
      expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId,
        logicalDate: '2026-08-30' as LogicalDate, source: 'app' })).toMatchObject({ ok: true });
      const before = {
        queue: await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
        actions: await h.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id'),
        ledger: await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id'),
      };
      expect(before.ledger).toHaveLength(1);
      let rejected = false;
      const transport: SyncTransport = { ensureZone: async () => {}, fetchChanges: emptyPage,
        upload: async records => {
          if (records.some(record => String(record.entityType) === 'habit_action')) {
            rejected = true;
            throw new SyncTransportError('failure', 'test immutable comparison refused');
          }
        } };
      expect(await runSync(deps(h, transport))).toMatchObject({ ok: true, value: { status: 'needs_attention' } });
      expect(rejected).toBe(true);
      expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id')).toEqual(before.queue);
      expect(await h.db.getAllAsync('SELECT * FROM habit_actions ORDER BY id')).toEqual(before.actions);
      expect(await h.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(before.ledger);
    } finally { await h.db.closeAsync(); }
  });
});
