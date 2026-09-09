import { runCommand, type CommandContext } from '@/core/domain/command-context';
import { createBoard } from '@/core/domain/commands';
import { getBoard } from '@/core/domain/queries';
import { ok } from '@/core/domain/result';
import { getReceipt, getSettings } from '@/core/persistence/repositories/support';
import { decodeStamp, encodeStamp } from '@/core/sync/hybrid-clock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

describe('accepted stamp observation in a command receipt', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it('shares received and local stamps in one saved accumulator and replays before touching providers', async () => {
    const commandId = h.ids.nextCommandId();
    const wallTime = h.clock.utcMs + 100000;
    const remote = encodeStamp({ wallTime, counter: 7 }, 'remote');
    const result = await runCommand(h.deps, commandId, async context => {
      context.observeStamp(remote);
      const local = context.stamp();
      expect(decodeStamp(local)).toMatchObject({ wallTime, counter: 8 });
      context.observeStamp(encodeStamp({ wallTime, counter: 12 }, 'later'));
      context.observeStamp(encodeStamp({ wallTime: wallTime - 1, counter: 99 }, 'older'));
      return ok({ local });
    });
    expect(result.ok).toBe(true);
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: wallTime, hlcCounter: 12 });
    expect(JSON.parse((await getReceipt(h.db, commandId))!)).toEqual(result);

    const work = jest.fn(async () => { throw new Error('receipt must replay before work'); });
    const clock = jest.spyOn(h.clock, 'nowUtcMs').mockImplementation(() => { throw new Error('clock unavailable'); });
    expect(await runCommand(h.deps, commandId, work)).toEqual(result);
    expect(work).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();

    const created = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title: 'after restore',
      symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: true,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('board creation failed');
    const board = await getBoard(h.deps, created.value.boardId);
    if (!board.ok) throw new Error('board read failed');
    expect(decodeStamp(board.value.mutationStamp)).toMatchObject({ wallTime, counter: 13 });
  });

  it('persists observation without creating a new local mutation stamp', async () => {
    const remote = { wallTime: h.clock.utcMs + 100000, counter: 5 };
    expect(await runCommand(h.deps, h.ids.nextCommandId(), async context => {
      context.observeStamp(encodeStamp(remote, 'remote'));
      return ok(undefined);
    })).toEqual(ok(undefined));
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: remote.wallTime, hlcCounter: remote.counter });
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([]);
  });

  it('rolls observed state and caller writes back on a late receipt failure, then retries the same command', async () => {
    const before = await getSettings(h.db);
    const commandId = h.ids.nextCommandId();
    const remote = { wallTime: h.clock.utcMs + 100000, counter: 9 };
    const run = h.db.runAsync.bind(h.db);
    const fault = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await run(sql, params);
      if (sql.includes('INSERT INTO command_receipts')) throw new Error('late receipt failure');
      return result;
    });
    const work = async (context: CommandContext) => {
      context.observeStamp(encodeStamp(remote, 'remote'));
      await context.tx.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      return ok(undefined);
    };
    expect(await runCommand(h.deps, commandId, work)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await getSettings(h.db)).toEqual(before);
    expect(await getReceipt(h.db, commandId)).toBeNull();
    fault.mockRestore();
    expect(await runCommand(h.deps, commandId, work)).toEqual(ok(undefined));
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: remote.wallTime, hlcCounter: remote.counter,
      iCloudSyncEnabled: true });
  });
});
