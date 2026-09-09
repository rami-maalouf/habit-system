import { createBoard, setICloudSyncEnabled } from '@/core/domain/commands';
import { SyncCoordinator } from '@/features/product-store/sync-coordinator';
import { NotificationCoordinator } from '@/features/product-store/notification-coordinator';
import { missAlertScheduler, reminderScheduler, notificationsPlatformMock } from '@/testing/notifications-platform.mock';

import { FakeSyncTransport } from '../helpers/fake-transport';
import { createTestHarness } from '../helpers/test-db';

it('retires sync dispatch immediately but joins the actual already-dispatched transport before returning', async () => {
  const harness = await createTestHarness();
  await setICloudSyncEnabled(harness.deps, { commandId: harness.ids.nextCommandId(), enabled: true });
  const transport = new FakeSyncTransport();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  transport.ensureZone = jest.fn(async () => { entered(); await held; });
  const fetch = jest.spyOn(transport, 'fetchChanges');
  const coordinator = new SyncCoordinator(harness.deps, transport, jest.fn(), jest.fn());
  const running = coordinator.request();
  await started;
  let finished = false;
  const join = Promise.resolve(coordinator.dispose()).then(() => { finished = true; });
  await Promise.resolve();
  const finishedEarly = finished;
  await coordinator.request();
  release();
  await Promise.all([join, running]);
  expect(finishedEarly).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(transport.ensureZone).toHaveBeenCalledTimes(1);
  await harness.db.closeAsync();
});

it('joins the actual notification inspection runner and accepts no successor pass after disposal', async () => {
  const harness = await createTestHarness();
  notificationsPlatformMock.reset();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const pendingRequests = jest.fn(async () => { entered(); await held; return []; });
  const coordinator = new NotificationCoordinator(harness.deps, { ...missAlertScheduler, pendingRequests },
    reminderScheduler, true, jest.fn(), jest.fn());
  coordinator.request(false);
  await started;
  let finished = false;
  const join = Promise.resolve(coordinator.dispose()).then(() => { finished = true; });
  await Promise.resolve();
  const finishedEarly = finished;
  coordinator.request();
  release();
  await join;
  expect(finishedEarly).toBe(false);
  expect(pendingRequests).toHaveBeenCalledTimes(1);
  expect(await harness.db.getAllAsync('SELECT * FROM miss_alerts')).toEqual([]);
  await harness.db.closeAsync();
});

it.each([false, true])('preserves a request queued as a completed pass publishes, respecting retirement: %s', async retire => {
  const harness = await createTestHarness();
  notificationsPlatformMock.reset();
  const created = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Missed twice', kind: 'daily',
    symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  expect(created.ok).toBe(true);
  harness.clock.advanceDays(2);
  const inspect = jest.fn(async () => []);
  let coordinator!: NotificationCoordinator;
  const refreshed = jest.fn(() => {
    void Promise.resolve().then(() => {
      coordinator.request(false);
      if (retire) void coordinator.dispose();
    });
  });
  coordinator = new NotificationCoordinator(harness.deps, { ...missAlertScheduler, pendingRequests: inspect },
    reminderScheduler, true, refreshed, jest.fn());
  try {
    coordinator.request(false);
    // finish the queued microtasks and real sqlite work without an elapsed-time delay.
    await new Promise<void>(resolve => setImmediate(resolve));
    await coordinator.dispose();
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(retire ? 1 : 2);
  } finally { await coordinator.dispose(); await harness.db.closeAsync(); }
});
