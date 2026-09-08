import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { ScrollView, Text } from 'react-native';

import { archiveBoard, createBoard, createCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { ok } from '@/core/domain/result';
import * as queries from '@/core/domain/stack-queries';
import type { StackDetailSnapshot, StackListSnapshot } from '@/core/domain/stack-queries';
import type { ProductCore } from '@/platform/database/product-core';
import * as timeChange from '@/platform/time-change';
import { ProductProvider } from '@/features/product-store';
import { useStackSnapshot } from '@/features/stacks/use-stack-snapshot';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { widgetsPlatformMock } from '../../../src/testing/widgets-platform.mock';
import { fireEvent, renderComponent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function seed(title: string, root?: BoardId, startOfDayMinute = 0) {
  const result = await createBoard(await core(), { commandId: newCommandId(), title, kind: 'daily',
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute, metricsEnabled: true,
    anchor: root ? { kind: 'board', relation: 'after', boardId: root } : { kind: 'text', relation: 'after', text: 'getting home' },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

describe('stack snapshot refresh', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); widgetsPlatformMock.reset(); jest.useFakeTimers(); });

  it('refreshes an archived root at its shifted week boundary without republishing widgets or resetting calendar scroll', async () => {
    mockClock.utcMs = Date.UTC(2026, 7, 31, 16);
    const root = await seed('Archived root', undefined, 240);
    const child = await seed('Active child', root);
    mockClock.utcMs = Date.UTC(2026, 8, 4, 16);
    expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId: root })).ok).toBe(true);
    mockClock.utcMs = Date.UTC(2026, 8, 7, 7, 59);
    expect((await createCheckIn(await core(), { commandId: newCommandId(), boardId: child, logicalDate: '2026-09-06' as LogicalDate, source: 'app' })).ok).toBe(true);
    renderRouter('src/app', { initialUrl: `/stacks/${root}` });
    await screen.findByTestId('stack-heatmap');
    await settle();
    expect(screen.getByLabelText('Stack date: 2026-09-06')).toBeOnTheScreen();
    expect(screen.getByText('1 complete day this week')).toBeOnTheScreen();
    const horizontal = screen.UNSAFE_getAllByType(ScrollView).find((view) => view.props.horizontal)!;
    const scroll = horizontal.instance as ScrollView;
    jest.mocked(scroll.scrollToEnd).mockClear();
    const publications = widgetsPlatformMock.refreshCalls;

    mockClock.utcMs = Date.UTC(2026, 8, 7, 8);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await settle();
    expect(screen.getByLabelText('Stack date: 2026-09-07')).toBeOnTheScreen();
    expect(screen.getByText('0 complete days this week')).toBeOnTheScreen();
    expect(screen.getByText('1-day streak')).toBeOnTheScreen();
    expect(widgetsPlatformMock.refreshCalls).toBe(publications);
    fireEvent(horizontal, 'contentSizeChange', 1000, 109);
    expect(scroll.scrollToEnd).not.toHaveBeenCalled();
  });

  it('recovers from a rejected list query once the bounded retry expires', async () => {
    const root = await seed('Retry stack');
    const query = jest.spyOn(queries, 'getStackListSnapshot').mockRejectedValueOnce(new Error('temporary query failure'));
    renderRouter('src/app', { initialUrl: '/stacks' });
    expect(await screen.findByTestId('stacks-error')).toHaveTextContent('temporary query failure');
    const failedCalls = query.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(29_000); });
    expect(query).toHaveBeenCalledTimes(failedCalls);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await settle();
    expect(await screen.findByTestId(`stack-card-${root}`)).toBeOnTheScreen();
    expect(query).toHaveBeenCalledTimes(failedCalls + 1);
  });

  it('discards an old root result after a route-parameter change and retains the new boundary timer', async () => {
    const first = await seed('First stack');
    const second = await seed('Second stack');
    const old = await queries.getStackDetailSnapshot(await core(), first);
    if (!old.ok) throw new Error(old.error.message);
    let finish!: (value: ReturnType<typeof ok<StackDetailSnapshot>>) => void;
    jest.spyOn(queries, 'getStackDetailSnapshot').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderRouter('src/app', { initialUrl: `/stacks/${first}` });
    await screen.findByTestId('stack-loading');
    act(() => router.setParams({ rootId: second }));
    await settle();
    expect(await screen.findByTestId(`stack-member-${second}`)).toHaveTextContent('Second stack', { exact: false });
    await act(async () => { finish(old); await Promise.resolve(); });
    await settle();
    expect(screen.queryByTestId(`stack-member-${first}`)).toBeNull();
    expect(screen).toHavePathname(`/stacks/${second}`);
  });

  it('does not display an already expired response and does not retry after unmount', async () => {
    const deps = await core();
    const value: StackListSnapshot = { generatedAtUtc: mockClock.utcMs, timeZoneId: mockClock.zone, refreshAtUtc: mockClock.utcMs + 1000, stacks: [] };
    let finish!: (value: ReturnType<typeof ok<StackListSnapshot>>) => void;
    const query = jest.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockImplementation(() => Promise.resolve(ok({ ...value, generatedAtUtc: mockClock.utcMs, refreshAtUtc: mockClock.utcMs + 60_000 })));
    function Probe() {
      const state = useStackSnapshot(query, 'probe');
      return <Text testID="snapshot-state">{state.status === 'ready' ? state.value.generatedAtUtc : state.status}</Text>;
    }
    const rendered = renderComponent(<ProductProvider coreOverride={deps as ProductCore}><Probe /></ProductProvider>);
    await settle();
    mockClock.utcMs += 2000;
    await act(async () => { finish(ok(value)); await Promise.resolve(); });
    await settle();
    expect(screen.getByTestId('snapshot-state')).toHaveTextContent(String(mockClock.utcMs));
    expect(query).toHaveBeenCalledTimes(2);
    rendered.unmount();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('ignores an older list response after a time-zone invalidation and keeps the newer deadline', async () => {
    await seed('Travel stack');
    const actual = queries.getStackListSnapshot;
    const previous = await actual(await core());
    if (!previous.ok) throw new Error(previous.error.message);
    let finish!: (value: typeof previous) => void;
    const query = jest.spyOn(queries, 'getStackListSnapshot').mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    let changed = () => {};
    jest.spyOn(timeChange, 'addSignificantTimeChangeListener').mockImplementation((listener) => { changed = listener; return () => {}; });
    renderRouter('src/app', { initialUrl: '/stacks' });
    await screen.findByTestId('stacks-loading');
    mockClock.zone = 'Europe/Paris';
    act(() => changed());
    await settle();
    await screen.findByTestId(`stack-card-${previous.value.stacks[0].rootId}`);
    const next = await actual(await core());
    if (!next.ok || next.value.refreshAtUtc === null) throw new Error('missing fresh deadline');
    expect(next.value.refreshAtUtc).toBeLessThan(previous.value.refreshAtUtc!);
    await act(async () => { finish(previous); await Promise.resolve(); });
    await settle();
    const before = query.mock.calls.length;
    const elapsed = next.value.refreshAtUtc - mockClock.utcMs;
    mockClock.utcMs = next.value.refreshAtUtc;
    await act(async () => { jest.advanceTimersByTime(elapsed); });
    await settle();
    expect(query.mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByLabelText('Stack date: 2026-08-31')).toBeOnTheScreen();
  });

  it('does not launch an expired-response retry after the pending consumer unmounts', async () => {
    let finish!: (value: ReturnType<typeof ok<StackListSnapshot>>) => void;
    const query = jest.fn(() => new Promise<ReturnType<typeof ok<StackListSnapshot>>>((resolve) => { finish = resolve; }));
    function Probe() { useStackSnapshot(query, 'unmounted'); return null; }
    const rendered = renderComponent(<ProductProvider coreOverride={await core() as ProductCore}><Probe /></ProductProvider>);
    await settle();
    rendered.unmount();
    await act(async () => {
      finish(ok({ generatedAtUtc: 1, refreshAtUtc: 2, timeZoneId: 'UTC', stacks: [] }));
      await Promise.resolve();
    });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated expired responses to one reread and a delayed recovery', async () => {
    const expired: StackListSnapshot = { generatedAtUtc: 1, refreshAtUtc: 2, timeZoneId: 'UTC', stacks: [] };
    const fresh = { ...expired, generatedAtUtc: mockClock.utcMs, refreshAtUtc: mockClock.utcMs + 60_000 };
    const query = jest.fn().mockResolvedValueOnce(ok(expired)).mockResolvedValueOnce(ok(expired)).mockResolvedValue(ok(fresh));
    function Probe() {
      const state = useStackSnapshot(query, 'repeated-expiry');
      return <Text testID="snapshot-state">{state.status === 'ready' ? state.value.generatedAtUtc : state.status === 'error' ? state.error.message : state.status}</Text>;
    }
    renderComponent(<ProductProvider coreOverride={await core() as ProductCore}><Probe /></ProductProvider>);
    await settle();
    expect(screen.getByTestId('snapshot-state')).toHaveTextContent('Stack information changed while loading. Try again.');
    expect(query).toHaveBeenCalledTimes(2);
    await act(async () => { jest.advanceTimersByTime(29_000); });
    expect(query).toHaveBeenCalledTimes(2);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await settle();
    expect(query).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('snapshot-state')).toHaveTextContent(String(fresh.generatedAtUtc));
  });
});
