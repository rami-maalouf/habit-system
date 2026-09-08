import { act } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import { currentLogicalDate } from '@/core/calendar/logical-date';
import * as projections from '@/core/domain/widget-projection';
import type { WidgetProjectionSnapshot } from '@/core/domain/widget-projection';
import { err, ok } from '@/core/domain/result';
import * as timeChange from '@/platform/time-change';
import type { ProductCore } from '@/platform/database/product-core';
import cases from '@/core/automations/fixtures/widget-refresh.json';

import { ProductProvider, useProduct } from '../../../src/features/product-store';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { widgetsPlatformMock } from '../../../src/testing/widgets-platform.mock';
import { renderComponent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seed(startOfDayMinute: number) {
  const result = await createBoard(await core(), {
    commandId: newCommandId(), title: 'shifted habit', kind: 'daily', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

function Probe() {
  return <Text testID="provider-version">{useProduct().version}</Text>;
}

describe('widget cache and foreground deadlines', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetProductCoreForTests();
    widgetsPlatformMock.reset();
    jest.useFakeTimers();
  });

  it.each(cases.boundaryCases.filter((entry) => [
    'shifted four am', 'spring skipped threshold', 'fall first threshold',
    'fall rollback changes logical date', 'fall second threshold',
  ].includes(entry.name)))('refreshes Home and the actual widget strip at $name', async (entry) => {
    mockClock.zone = entry.timeZoneId;
    mockClock.utcMs = entry.nowUtcMs - 2 * 24 * 60 * 60 * 1000;
    const startMinute = entry.startMinutes[0];
    const boardId = await seed(startMinute);
    mockClock.utcMs = entry.nowUtcMs;
    expect((await createCheckIn(await core(), { commandId: newCommandId(), boardId, source: 'app' })).ok).toBe(true);
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0-quick');
    await settle();
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked).toBe(true);
    expect(widgetsPlatformMock.snapshots.at(-1)).toMatchObject({ generatedAtUtc: entry.nowUtcMs, expiresAtUtc: entry.expectedExpiresAtUtc });
    const before = widgetsPlatformMock.snapshots.length;

    mockClock.utcMs = entry.expectedExpiresAtUtc;
    await act(async () => { jest.advanceTimersByTime(entry.expectedExpiresAtUtc - entry.nowUtcMs); });
    await settle();

    expect(widgetsPlatformMock.snapshots.length).toBeGreaterThan(before);
    const latest = widgetsPlatformMock.snapshots.at(-1);
    expect(latest?.generatedAtUtc).toBe(entry.expectedExpiresAtUtc);
    expect(latest?.rows[0].stripEndDate).toBe(currentLogicalDate(entry.expectedExpiresAtUtc, entry.timeZoneId, startMinute));
    expect(latest?.rows[0].strip.at(-1)).toBe(0);
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked).toBe(false);
  });

  it('discards an older refresh after a time-zone change and keeps the newer timer', async () => {
    const deps = await core();
    const actualRefresh = projections.refreshWidgetProjection;
    const oldSnapshot = await actualRefresh(deps);
    if (!oldSnapshot.ok) throw new Error(oldSnapshot.error.message);
    let resolveOld!: (value: ReturnType<typeof ok<WidgetProjectionSnapshot>>) => void;
    const oldResult = new Promise<ReturnType<typeof ok<WidgetProjectionSnapshot>>>((resolve) => { resolveOld = resolve; });
    jest.spyOn(projections, 'refreshWidgetProjection').mockImplementationOnce(() => oldResult);
    let timeChanged = () => {};
    jest.spyOn(timeChange, 'addSignificantTimeChangeListener').mockImplementation((listener) => { timeChanged = listener; return () => {}; });
    renderComponent(<ProductProvider coreOverride={deps as ProductCore}><Probe /></ProductProvider>);
    await settle();
    mockClock.zone = 'Europe/Paris';
    act(() => timeChanged());
    await settle();
    expect(widgetsPlatformMock.snapshots).toHaveLength(1);
    const current = widgetsPlatformMock.snapshots[0];
    expect(current.expiresAtUtc).toBeLessThan(oldSnapshot.value.expiresAtUtc);

    await act(async () => { resolveOld(oldSnapshot); await Promise.resolve(); });
    await settle();
    expect(widgetsPlatformMock.snapshots).toEqual([current]);
    const before = mockClock.utcMs;
    mockClock.utcMs = current.expiresAtUtc;
    await act(async () => { jest.advanceTimersByTime(current.expiresAtUtc - before); });
    await settle();
    expect(widgetsPlatformMock.snapshots.at(-1)?.generatedAtUtc).toBe(current.expiresAtUtc);
  });

  it('does not publish a fresh-looking timeline after cache refresh failure', async () => {
    jest.spyOn(projections, 'refreshWidgetProjection').mockResolvedValue(err('database', 'cache is locked', { retryable: true }));
    renderComponent(<ProductProvider coreOverride={await core() as ProductCore}><Probe /></ProductProvider>);
    await settle();
    expect(widgetsPlatformMock.refreshCalls).toBe(0);
  });

  it.each(['result', 'rejection'])('recovers from one cache %s while still foregrounded', async (failure) => {
    const refresh = jest.spyOn(projections, 'refreshWidgetProjection');
    if (failure === 'result') refresh.mockResolvedValueOnce(err('database', 'cache is locked', { retryable: true }));
    else refresh.mockRejectedValueOnce(new Error('cache is locked'));
    renderComponent(<ProductProvider coreOverride={await core() as ProductCore}><Probe /></ProductProvider>);
    await settle();
    expect(widgetsPlatformMock.refreshCalls).toBe(0);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle();
    expect(widgetsPlatformMock.refreshCalls).toBe(1);
    expect(widgetsPlatformMock.snapshots[0].generatedAtUtc).toBe(mockClock.utcMs);
  });

  it('skips a snapshot that expired in flight and publishes a new one', async () => {
    const deps = await core();
    const old = await projections.refreshWidgetProjection(deps);
    if (!old.ok) throw new Error(old.error.message);
    let finish!: (value: typeof old) => void;
    jest.spyOn(projections, 'refreshWidgetProjection').mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderComponent(<ProductProvider coreOverride={deps as ProductCore}><Probe /></ProductProvider>);
    await settle();
    mockClock.utcMs = old.value.expiresAtUtc;
    await act(async () => { finish(old); await Promise.resolve(); });
    expect(widgetsPlatformMock.refreshCalls).toBe(0);
    await settle();
    expect(widgetsPlatformMock.snapshots).toHaveLength(1);
    expect(widgetsPlatformMock.snapshots[0].generatedAtUtc).toBe(mockClock.utcMs);
  });

  it('does not publish a late refresh after provider unmount', async () => {
    const deps = await core();
    const snapshot = await projections.refreshWidgetProjection(deps);
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    let finish!: (value: ReturnType<typeof ok<WidgetProjectionSnapshot>>) => void;
    jest.spyOn(projections, 'refreshWidgetProjection').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const rendered = renderComponent(<ProductProvider coreOverride={deps as ProductCore}><Probe /></ProductProvider>);
    await settle();
    rendered.unmount();
    await act(async () => { finish(snapshot); await Promise.resolve(); });
    expect(widgetsPlatformMock.refreshCalls).toBe(0);
  });
});
