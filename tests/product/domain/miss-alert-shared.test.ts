import fixture from '@/core/automations/fixtures/miss-alert-contract.json';
import { createBoard, createCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { reconcileMissAlerts } from '@/core/domain/miss-alert-reconciliation';
import { isMissAlertPairValid, planMissAlertPair, planMissAlertTrigger, type MissAlertBoard, type MissAlertBoardEvidence } from '@/core/domain/miss-alerts';
import type { MissAlertScheduler, ReminderAuthorization } from '@/core/domain/ports';
import { readMissAlertRows, replaceMissAlertRow, type MissAlertRow } from '@/core/persistence/repositories/miss-alerts';
import { createTestHarness } from '../helpers/test-db';

it.each(fixture.policy)('matches the shared native policy literal: $name', vector => {
  const board = { ...fixture.board, ...('kind' in vector ? { kind: vector.kind } : {}),
    ...('startOfDayMinute' in vector ? { startOfDayMinute: vector.startOfDayMinute } : {}),
    ...('archivedAt' in vector ? { archivedAt: vector.archivedAt } : {}),
    ...('deletedAt' in vector ? { deletedAt: vector.deletedAt } : {}) } as MissAlertBoard;
  const evidence = { board, periods: vector.periods, effectiveCheckedDates: vector.checks } as MissAlertBoardEvidence;
  const time = { nowUtcMs: Date.parse(vector.now), timeZoneId: vector.zone, foreground: vector.foreground };
  expect(isMissAlertPairValid({ boardId: board.id, secondMissedDate: vector.pair as LogicalDate }, evidence, time)).toBe(vector.valid);
  expect(planMissAlertPair(evidence, time)?.secondMissedDate ?? null).toBe(vector.candidate);
  expect(planMissAlertTrigger(time)).toEqual(vector.trigger);
});
it.each(fixture.rows)('matches the acquired SQL and port row literal: $name', async vector => {
  const h = await createTestHarness();
  try {
    const context = fixture.rowContext;
    h.clock.zone = context.zone; h.clock.utcMs = Date.parse(`${context.periods[0].startDate}T16:00:00Z`);
    const commandId = h.ids.nextCommandId();
    jest.spyOn(h.ids, 'uuid').mockReturnValueOnce(context.boardId);
    const created = await createBoard(h.deps, { commandId, ...fixture.board, kind: 'daily', symbol: 'book.fill', accentHex: '#70A7FF',
      usesTintedBackground: false, tracksAmount: false, tracksTime: false, metricsEnabled: true });
    expect(created).toEqual({ ok: true, value: { boardId: context.boardId } });
    h.clock.utcMs = Date.parse(context.now);
    for (const date of context.checks) expect((await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), source: 'app',
      boardId: context.boardId as BoardId, logicalDate: date as LogicalDate })).ok).toBe(true);
    const pair = { boardId: context.boardId as BoardId, secondMissedDate: context.secondMissedDate as LogicalDate };
    if (vector.prior) await h.db.withExclusiveTransactionAsync(tx => replaceMissAlertRow(tx, null, {
      ...pair, status: vector.prior!.status, nativeIdentifier: vector.prior!.hasIdentifier ? vector.finalIdentifier : null,
    } as MissAlertRow));
    const scheduler: jest.Mocked<MissAlertScheduler> = { authorization: jest.fn().mockResolvedValue(vector.authorization as ReminderAuthorization),
      pendingRequests: jest.fn().mockResolvedValue(context.pending), presentedIdentifiers: jest.fn().mockResolvedValue(context.presented),
      cancel: jest.fn(), refreshPending: jest.fn(), schedule: jest.fn().mockResolvedValue(vector.outcome === 'not_accepted'
        ? { kind: 'not_accepted', code: 'schedule_failed' } : { kind: vector.outcome }) };
    await reconcileMissAlerts({ db: h.db, clock: h.clock, scheduler }, { isCurrent: () => true, isForeground: () => context.foreground });
    expect(await readMissAlertRows(h.db, [pair])).toEqual([{ ...pair, status: vector.finalStatus, nativeIdentifier: vector.finalIdentifier }]);
    expect(scheduler.schedule).toHaveBeenCalledTimes(vector.adds);
    expect(scheduler.cancel).not.toHaveBeenCalled(); expect(scheduler.refreshPending).not.toHaveBeenCalled();
  } finally { jest.restoreAllMocks(); await h.db.closeAsync(); }
});
