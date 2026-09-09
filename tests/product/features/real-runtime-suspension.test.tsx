import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { router } from 'expo-router';

import { createBoard, setICloudSyncEnabled } from '@/core/domain/commands';
import { createReminder } from '@/core/domain/reminder-commands';
import { err, ok } from '@/core/domain/result';
import { ProductProvider, useProduct, useProductQuery } from '@/features/product-store';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import * as widgets from '@/testing/widgets-platform.mock';
import * as notifications from '@/testing/notifications-platform.mock';
import * as coreModule from '@/testing/product-core.mock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';
import { FakeSyncTransport } from '../helpers/fake-transport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('real host suspension before sample creation', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    jest.useFakeTimers();
    harness = await createTestHarness();
    notifications.notificationsPlatformMock.reset(); widgets.widgetsPlatformMock.reset();
  });
  afterEach(async () => { jest.restoreAllMocks(); jest.useRealTimers(); await harness.db.closeAsync(); });

  it('joins native widget publication and a full accepted command even if one participant rejects', async () => {
    const timeline = deferred<void>(), permission = deferred<void>();
    const published = jest.spyOn(widgets, 'refreshWidgets').mockReturnValue(timeline.promise);
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    let product!: ReturnType<typeof useProduct>;
    let mounts = 0;
    function Probe() {
      product = useProduct();
      const count = useProductQuery(async core => ok((await core.db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM boards'))!.count), []);
      return <Text testID="count">{count.status === 'ready' ? count.value : count.status}</Text>;
    }
    function Mounted() { mounts++; return <Probe />; }
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}><Mounted /></ProductProvider></SampleSessionProvider>);
    await act(async () => {});
    expect(published).toHaveBeenCalledTimes(1);
    const original = product;
    const oldQuick = [...widgets.widgetsPlatformMock.quickHandlers][0];
    const oldTap = [...notifications.notificationsPlatformMock.destinationHandlers][0];
    const oldDelivery = [...notifications.notificationsPlatformMock.deliveryHandlers][0];
    const work = original.scope.run(async ({ core }) => {
      await permission.promise;
      return createBoard(core, { commandId: harness.ids.nextCommandId(), title: 'Accepted before sample', symbol: 'star.fill',
        accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    });
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => {});
    const openedEarly = open.mock.calls.length;
    expect(original.scope.isCurrent()).toBe(false);
    expect(widgets.widgetsPlatformMock.quickHandlers.size).toBe(0);
    expect(notifications.notificationsPlatformMock.destinationHandlers.size).toBe(0);
    expect(notifications.notificationsPlatformMock.deliveryHandlers.size).toBe(0);
    await act(async () => { timeline.reject(new Error('native publication failed')); });
    expect(open).not.toHaveBeenCalled();
    await act(async () => { permission.resolve(); await work; await entering; });
    expect(openedEarly).toBe(0);
    expect(open).toHaveBeenCalledTimes(1);
    expect(await harness.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Accepted before sample' }]);
    expect(screen.getByTestId('count')).toHaveTextContent('0');
    expect(mounts).toBe(1);
    await act(async () => { await session.close(); });
    expect(product.core).toBe(original.core);
    expect(product.scope).not.toBe(original.scope);
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    const resumedVersion = product.version, resumedMissVersion = product.missAlertVersion;
    const navigate = jest.spyOn(router, 'navigate'), push = jest.spyOn(router, 'push');
    act(() => {
      original.invalidate(); original.syncNow(); original.pauseSync(); original.resumeSync();
      oldQuick('00000000-0000-4000-8000-000000000123');
      oldTap({ kind: 'board', boardId: '00000000-0000-4000-8000-000000000123' }); oldDelivery();
    });
    await act(async () => {});
    expect(() => original.nextCommandId()).toThrow('inactive');
    expect(product.version).toBe(resumedVersion);
    expect(product.missAlertVersion).toBe(resumedMissVersion);
    expect(navigate).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    view.unmount();
  });

  it('waits for an already-started real open and keeps its eventual ready owner inactive until Close', async () => {
    const opening = deferred<ReturnType<typeof ok<typeof harness.deps>>>();
    const realOpen = jest.spyOn(coreModule, 'getProductCore').mockReturnValue(opening.promise);
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    let product: ReturnType<typeof useProduct> | undefined;
    function Probe() { product = useProduct(); return <Text>real body</Text>; }
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider><Probe /></ProductProvider></SampleSessionProvider>);
    expect(realOpen).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => {});
    const openedEarly = open.mock.calls.length;
    await act(async () => { opening.resolve(ok(harness.deps)); await entering; });
    expect(openedEarly).toBe(0);
    expect(product!.scope.active).toBe(false);
    expect(widgets.widgetsPlatformMock.refreshCalls).toBe(0);
    await act(async () => { await session.close(); });
    expect(product!.scope.isCurrent()).toBe(true);
    expect(realOpen).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('suppresses a late initial notification destination and never rereads it after resume', async () => {
    const response = deferred<{ kind: 'board'; boardId: string } | null>();
    const initial = jest.spyOn(notifications, 'getInitialNotificationDestination').mockReturnValue(response.promise);
    const push = jest.spyOn(router, 'push');
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}><Text>real</Text></ProductProvider></SampleSessionProvider>);
    await act(async () => {});
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => { response.resolve({ kind: 'board', boardId: '00000000-0000-4000-8000-000000000123' }); await entering; });
    await act(async () => { await session.close(); });
    expect(initial).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    view.unmount();
  });

  it('joins both actual sync and miss inspection runners before the sample factory can establish its baseline', async () => {
    const previous = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    const network = deferred<void>(), inspected = deferred<void>();
    const networkStarted = deferred<void>(), inspectionStarted = deferred<void>();
    const transport = new FakeSyncTransport();
    transport.ensureZone = jest.fn(async () => { networkStarted.resolve(); await network.promise; });
    const fetch = jest.spyOn(transport, 'fetchChanges');
    const pendingRequests = jest.fn(async () => { inspectionStarted.resolve(); await inspected.promise; return []; });
    await setICloudSyncEnabled(harness.deps, { commandId: harness.ids.nextCommandId(), enabled: true });
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}
      syncTransportOverride={transport} missAlertSchedulerOverride={{ ...notifications.missAlertScheduler, pendingRequests }}><Text>real</Text></ProductProvider></SampleSessionProvider>);
    try {
      await act(async () => { await Promise.all([networkStarted.promise, inspectionStarted.promise]); });
      let entering!: Promise<void>;
      act(() => { entering = session.enter(); });
      await act(async () => { network.resolve(); });
      expect(open).not.toHaveBeenCalled();
      await act(async () => { inspected.resolve(); await entering; });
      expect(open).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(pendingRequests).toHaveBeenCalledTimes(1);
      expect(await harness.db.getAllAsync('SELECT * FROM miss_alerts')).toEqual([]);
    } finally { view.unmount(); Object.defineProperty(AppState, 'currentState', previous); }
  });

  it('joins an accepted real system prompt through the public reminder receipt and scheduling transaction', async () => {
    const board = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Reminder', symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw Error(board.error.message);
    const prompted = deferred<void>(), permission = deferred<'granted'>();
    jest.spyOn(notifications.reminderScheduler, 'authorization').mockResolvedValue('undetermined');
    jest.spyOn(notifications.reminderScheduler, 'requestAuthorization').mockImplementation(() => { prompted.resolve(); return permission.promise; });
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    let product!: ReturnType<typeof useProduct>;
    function Probe() { product = useProduct(); return <Text>real</Text>; }
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}><Probe /></ProductProvider></SampleSessionProvider>);
    await act(async () => {});
    const commandId = harness.ids.nextCommandId();
    const saving = product.scope.run(({ core, effects }) => {
      if (effects.kind !== 'real') throw Error('expected real effects');
      return createReminder({ ...core, scheduler: effects.reminders }, { commandId, boardId: board.value.boardId,
        weekdaysMask: 1, minuteOfDay: 540, enabled: true });
    });
    await act(async () => { await prompted.promise; });
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    await act(async () => { permission.resolve('granted'); await entering; });
    const result = await saving;
    expect(result).toMatchObject({ started: true, value: { ok: true, value: { scheduleState: 'scheduled' } } });
    const receipt = await harness.db.getFirstAsync<{ outcome: string }>('SELECT outcome FROM command_receipts WHERE command_id = ?', [commandId]);
    expect(result.started && JSON.parse(receipt!.outcome)).toEqual(result.started && result.value);
    expect(open).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('joins a dispatched widget quick-create transaction without stale navigation or publication', async () => {
    const board = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Count', kind: 'count', earnsCoins: true, symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw Error(board.error.message);
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}><Text>real</Text></ProductProvider></SampleSessionProvider>);
    await act(async () => {});
    const entered = deferred<void>(), hashing = deferred<void>();
    const original = harness.deps.hashing.sha1;
    jest.spyOn(harness.deps.hashing, 'sha1').mockImplementation(async bytes => { entered.resolve(); await hashing.promise; return original(bytes); });
    const navigate = jest.spyOn(router, 'navigate');
    act(() => widgets.widgetsPlatformMock.emitQuickAction(board.value.boardId));
    await act(async () => { await entered.promise; });
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    const publications = widgets.widgetsPlatformMock.refreshCalls;
    await act(async () => { hashing.resolve(); await entering; });
    expect(await harness.db.getAllAsync('SELECT source FROM check_ins')).toEqual([{ source: 'widget' }]);
    expect(navigate).not.toHaveBeenCalled();
    expect(widgets.widgetsPlatformMock.refreshCalls).toBe(publications);
    expect(open).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('opens a real runtime only after a cold sample-owned entry has finished closing', async () => {
    const realOpen = jest.spyOn(coreModule, 'getProductCore').mockResolvedValue(ok(harness.deps));
    const install = jest.spyOn(notifications, 'installNotificationHandler');
    const session = new SampleSession(async () => err('database', 'isolated initialization error'));
    await session.enter();
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider><Text>real body</Text></ProductProvider></SampleSessionProvider>);
    expect(screen.getByTestId('product-suspended')).toBeOnTheScreen();
    expect(realOpen).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    await act(async () => { await session.close(); });
    expect(screen.getByText('real body')).toBeOnTheScreen();
    expect(realOpen).toHaveBeenCalledTimes(1); expect(install).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('joins accepted work before reporting failed native cleanup and never treats retry as confirmed cleanup', async () => {
    const failure = new Error('native listener removal failed');
    const remove = jest.fn(() => { throw failure; });
    jest.spyOn(notifications, 'installNotificationHandler').mockReturnValue(remove);
    const open = jest.fn(async () => err('database', 'sample must remain unopened'));
    const session = new SampleSession(open);
    let product!: ReturnType<typeof useProduct>;
    function Probe() { product = useProduct(); return <Text>real</Text>; }
    const view = render(<SampleSessionProvider sessionOverride={session}><ProductProvider coreOverride={harness.deps}><Probe /></ProductProvider></SampleSessionProvider>);
    await act(async () => {});
    const accepted = deferred<void>();
    const work = product.scope.run(async ({ core }) => {
      await accepted.promise;
      await core.db.getFirstAsync('SELECT count(*) FROM boards');
    });
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await act(async () => {});
    expect(session.getSnapshot().status).toBe('opening');
    expect(open).not.toHaveBeenCalled();
    await act(async () => { accepted.resolve(); await work; await entering; });
    expect(session.getSnapshot()).toEqual({ status: 'error', message: failure.message, canRetry: true });
    await act(async () => { await session.enter(); });
    expect(session.getSnapshot()).toEqual({ status: 'error', message: failure.message, canRetry: true });
    expect(open).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    await act(async () => { await expect(session.close()).rejects.toBe(failure); });
    expect(product.scope.isCurrent()).toBe(false);
    view.unmount();
  });
});
