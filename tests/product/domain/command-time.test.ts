import { createBoard, createCheckIn } from '@/core/domain/commands';
import type { BoardId } from '@/core/domain/ids';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

async function makeBoard(h: TestHarness) {
  const result = await createBoard(h.deps, {
    commandId: h.ids.nextCommandId(), title: 'Morning reading', kind: 'daily',
    symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false,
    tracksAmount: false, amountUnit: null, quickAmount: 1, tracksTime: false,
    startOfDayMinute: 240, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function storedState(h: TestHarness) {
  const tables = await h.db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return Promise.all(tables.map(async ({ name }) => ({
    name,
    rows: await h.db.getAllAsync(`SELECT * FROM "${name.replaceAll('"', '""')}"`),
  })));
}

describe('command time at the acquired transaction', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it.each([
    { name: 'shift crossing', before: '2026-09-08T03:59:59.999Z', after: '2026-09-08T04:00:00.000Z', oldZone: 'UTC', newZone: 'UTC', date: '2026-09-08' },
    { name: 'time-zone change', before: '2026-09-08T23:00:00.000Z', after: '2026-09-08T23:00:00.000Z', oldZone: 'Pacific/Honolulu', newZone: 'Pacific/Auckland', date: '2026-09-09' },
  ])('assigns a queued check using the committed $name', async ({ before, after, oldZone, newZone, date }) => {
    const boardId = await makeBoard(h);
    h.clock.utcMs = Date.parse(before);
    h.clock.zone = oldZone;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = h.db.withExclusiveTransactionAsync(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await entered;
    const now = jest.spyOn(h.clock, 'nowUtcMs');
    const zone = jest.spyOn(h.clock, 'timeZoneId');
    const commandId = h.ids.nextCommandId();
    const pending = createCheckIn(h.deps, { commandId, boardId, source: 'app' });
    h.clock.utcMs = Date.parse(after);
    h.clock.zone = newZone;
    release();
    await held;

    const result = await pending;
    expect(result).toMatchObject({ ok: true, value: { logicalDate: date, created: true } });
    expect(await h.db.getFirstAsync('SELECT logical_date, created_at FROM check_ins WHERE idempotency_key = ?', [commandId]))
      .toEqual({ logical_date: date, created_at: Date.parse(after) });
    expect(await h.db.getFirstAsync('SELECT logical_date, created_at FROM habit_actions WHERE command_id = ?', [commandId]))
      .toEqual({ logical_date: date, created_at: Date.parse(after) });
    expect(await h.db.getFirstAsync('SELECT created_at FROM command_receipts WHERE command_id = ?', [commandId]))
      .toEqual({ created_at: Date.parse(after) });
    expect(now).toHaveBeenCalledTimes(1);
    expect(zone).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('replays a stored %s before consulting an unavailable clock', async (outcome) => {
    const boardId = outcome === 'success' ? await makeBoard(h) : h.ids.uuid() as BoardId;
    const input = { commandId: h.ids.nextCommandId(), boardId, source: 'app' as const };
    const first = await createCheckIn(h.deps, input);
    expect(first.ok).toBe(outcome === 'success');
    const before = await storedState(h);
    const now = jest.spyOn(h.clock, 'nowUtcMs').mockImplementation(() => { throw new Error('clock unavailable'); });
    const zone = jest.spyOn(h.clock, 'timeZoneId').mockImplementation(() => { throw new Error('zone unavailable'); });

    await expect(createCheckIn(h.deps, input)).resolves.toEqual(first);
    expect(now).not.toHaveBeenCalled();
    expect(zone).not.toHaveBeenCalled();
    expect(await storedState(h)).toEqual(before);
  });

  it.each(['nowUtcMs', 'timeZoneId'] as const)('rolls back when %s fails and permits the same command to retry', async (method) => {
    const boardId = await makeBoard(h);
    const input = { commandId: h.ids.nextCommandId(), boardId, source: 'app' as const };
    const before = await storedState(h);
    const unavailable = jest.spyOn(h.clock, method).mockImplementation(() => { throw new Error('clock unavailable'); });

    await expect(createCheckIn(h.deps, input)).resolves.toMatchObject({
      ok: false, error: { code: 'database', retryable: true },
    });
    expect(await storedState(h)).toEqual(before);
    unavailable.mockRestore();
    expect(await createCheckIn(h.deps, input)).toMatchObject({ ok: true, value: { created: true } });
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM check_ins')).toEqual({ count: 1 });
  });
});
