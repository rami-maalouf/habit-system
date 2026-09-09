import { setICloudSyncEnabled, updateBoard } from '@/core/domain/commands';
import { runCommand } from '@/core/domain/command-context';
import { getBoard } from '@/core/domain/queries';
import { ok } from '@/core/domain/result';
import { appendOutbox, getSettings } from '@/core/persistence/repositories/support';
import { runSync } from '@/core/sync/engine';
import { advance, decodeStamp, encodeStamp } from '@/core/sync/hybrid-clock';
import type { SyncRecord } from '@/core/sync/transport';

import { FakeSyncTransport } from '../helpers/fake-transport';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const maxCounter = 36 ** 5 - 1;
const maxWallTime = 99999999999999;

describe('clock rollover after a received mutation', () => {
  let h: TestHarness;
  let transport: FakeSyncTransport;
  beforeEach(async () => {
    h = await createTestHarness();
    transport = new FakeSyncTransport();
    expect(await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true })).toMatchObject({ ok: true });
  });
  afterEach(async () => { await h.db.closeAsync(); });
  const sync = () => runSync({ ...h.deps, transport, random: () => 0.5 });
  const snapshot = () => Promise.all(['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger',
    'mutation_outbox', 'command_receipts', 'app_settings', 'widget_board_rows'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));

  async function receive(wallTime: number, counter = maxCounter) {
    const boardId = await createBoardForTest(h);
    expect(await sync()).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    const uploaded = transport.store.get(`board:${boardId}`)!;
    const received: SyncRecord = { ...uploaded, mutationStamp: encodeStamp({ wallTime, counter }, 'remote'),
      fields: { ...uploaded.fields, title: 'remote title' } };
    transport.seedRemote(received);
    expect(await sync()).toMatchObject({ ok: true, value: { status: 'up_to_date', applied: 1 } });
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: wallTime, hlcCounter: counter });
    const edit = () => updateBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId,
      expectedMutationStamp: received.mutationStamp, title: 'edited after sync', symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: true, tracksAmount: false, tracksTime: false,
      startOfDayMinute: 0, metricsEnabled: true });
    return { boardId, received, edit };
  }

  it('keeps a local edit valid and later than the remote maximum counter through upload and replay', async () => {
    const wallTime = h.clock.utcMs + 100000;
    const { boardId, received, edit } = await receive(wallTime);
    expect(await edit()).toMatchObject({ ok: true });
    const saved = await getBoard(h.deps, boardId);
    if (!saved.ok) throw new Error('missing edited board');
    expect(saved.value.mutationStamp).toMatch(/^\d{14}-[0-9a-z]{5}-[A-Za-z0-9_-]+$/);
    expect(saved.value.mutationStamp > received.mutationStamp).toBe(true);
    expect(decodeStamp(saved.value.mutationStamp)).toMatchObject({ wallTime: wallTime + 1, counter: 0 });
    expect(await sync()).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
    expect(transport.store.get(`board:${boardId}`)).toMatchObject({ mutationStamp: saved.value.mutationStamp,
      fields: { title: 'edited after sync' } });
    expect(transport.rejectedStaleUploads).toEqual([]);
    const before = await snapshot();
    expect(await sync()).toMatchObject({ ok: true, value: { uploaded: 0, applied: 0 } });
    expect(await snapshot()).toEqual(before);
  });

  it('rolls the entire edit back when the full stamp space is exhausted', async () => {
    const { edit } = await receive(maxWallTime);
    const before = await snapshot();
    expect(await edit()).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot()).toEqual(before);
  });

  it('uses a newer physical time before carrying the counter and rejects an unencodable physical clock', () => {
    const state = { wallTime: 1000, counter: maxCounter };
    expect(advance(state, 1002)).toEqual({ wallTime: 1002, counter: 0 });
    expect(advance(state, 999)).toEqual({ wallTime: 1001, counter: 0 });
    expect(advance(state, 1000)).toEqual({ wallTime: 1001, counter: 0 });
    expect(advance({ wallTime: maxWallTime, counter: maxCounter - 1 }, maxWallTime))
      .toEqual({ wallTime: maxWallTime, counter: maxCounter });
    expect(() => advance({ wallTime: maxWallTime, counter: maxCounter }, maxWallTime)).toThrow();
    expect(() => advance({ wallTime: 1000, counter: 0 }, maxWallTime + 1)).toThrow();
    expect(state).toEqual({ wallTime: 1000, counter: maxCounter });
  });

  it('rolls earlier writes back when a later allocation in the same command exhausts the clock', async () => {
    const { boardId } = await receive(maxWallTime, maxCounter - 1);
    const before = await snapshot();
    let wrote = false;
    const result = await runCommand(h.deps, h.ids.nextCommandId(), async context => {
      const stamp = context.stamp();
      expect(stamp.startsWith('99999999999999-zzzzz-')).toBe(true);
      await appendOutbox(context.tx, 'board', boardId, stamp, context.now);
      wrote = true;
      context.stamp();
      return ok(undefined);
    });
    expect(wrote).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot()).toEqual(before);
  });
});
