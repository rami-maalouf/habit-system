import { createBoard, createCheckIn, updateCheckIn } from '@/core/domain/commands';
import type { LogicalDate } from '@/core/domain/ids';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

describe('historical timed check metadata', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); h.clock.zone = 'Europe/Paris'; });
  afterEach(async () => { await h.db.closeAsync(); });

  async function board() {
    const result = await createBoard(h.deps, {
      commandId: h.ids.nextCommandId(), title: 'Timed history', symbol: 'star.fill', accentHex: '#70A7FF',
      usesTintedBackground: false, tracksAmount: false, tracksTime: true, startOfDayMinute: 0, metricsEnabled: true,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }

  it.each([0, 45])('stores the exact historical offset when a check occurs at second %s', async (second) => {
    const boardId = await board();
    const instant = Date.parse('1900-01-01T00:00:00Z') + second * 1000;
    const result = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, occurredAtUtc: instant, source: 'app' });
    expect(result).toMatchObject({ ok: true, value: { logicalDate: '1900-01-01', created: true } });
    expect(await h.db.getFirstAsync('SELECT logical_date, occurred_at_utc, time_zone_id, offset_minutes FROM check_ins WHERE board_id = ?', [boardId]))
      .toEqual({ logical_date: '1900-01-01', occurred_at_utc: instant, time_zone_id: 'Europe/Paris', offset_minutes: 9.35 });
  });

  it('keeps the exact zone offset when an edit crosses a UTC minute boundary', async () => {
    const boardId = await board();
    const instant = Date.parse('1900-01-01T00:00:45Z');
    const created = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, occurredAtUtc: instant, source: 'app' });
    if (!created.ok) throw new Error(created.error.message);
    const original = (await h.db.getFirstAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM check_ins WHERE id = ?', [created.value.checkInId]))!;
    const result = await updateCheckIn(h.deps, {
      commandId: h.ids.nextCommandId(), checkInId: created.value.checkInId, expectedMutationStamp: original.mutation_stamp,
      logicalDate: '1900-01-01' as LogicalDate, occurredAtUtc: instant + 30_000,
    });
    expect(result.ok).toBe(true);
    expect(await h.db.getFirstAsync('SELECT occurred_at_utc, time_zone_id, offset_minutes FROM check_ins WHERE id = ?', [created.value.checkInId]))
      .toEqual({ occurred_at_utc: instant + 30_000, time_zone_id: 'Europe/Paris', offset_minutes: 9.35 });
  });
});
