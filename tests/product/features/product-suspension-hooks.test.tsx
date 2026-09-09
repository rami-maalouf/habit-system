import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ok } from '@/core/domain/result';
import { ProductProvider, useProduct, useProductQuery } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { useStackSnapshot } from '@/features/stacks/use-stack-snapshot';
import { useCoinHistory } from '@/features/coins/use-coin-history';
import * as coinQueries from '@/core/domain/coin-queries';
import { createBoard, createCheckIn } from '@/core/domain/commands';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

describe('retained query scopes', () => {
  let harness: TestHarness;
  let owner: OperationOwner;
  beforeEach(async () => {
    harness = await createTestHarness();
    owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    jest.useFakeTimers();
  });
  afterEach(async () => { jest.restoreAllMocks(); jest.useRealTimers(); await harness.db.closeAsync(); });

  it('joins a complete query continuation, preserves its previous value and refreshes only in the new scope', async () => {
    let release!: () => void;
    let held: Promise<void> | null = null;
    let reads = 0;
    let latest: ReturnType<typeof useProductQuery<number>>;
    let product: ReturnType<typeof useProduct>;
    function Probe() {
      product = useProduct();
      latest = useProductQuery(async core => {
        const value = ++reads;
        await held;
        await core.db.getFirstAsync('SELECT count(*) FROM boards');
        return ok(value);
      }, []);
      return <Text>{latest.status === 'ready' ? latest.value : latest.status}</Text>;
    }
    const view = render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    await act(async () => {});
    expect(screen.getByText('1')).toBeOnTheScreen();
    held = new Promise(resolve => { release = resolve; });
    act(() => { product!.invalidate(); });
    const oldRefresh = latest!.refresh;
    let finished = false;
    let join!: Promise<void>;
    act(() => { join = owner.suspend().then(() => { finished = true; }); });
    await act(async () => {});
    expect(finished).toBe(false);
    expect(reads).toBe(2);
    expect(screen.getByText('1')).toBeOnTheScreen();
    await act(async () => { release(); await join; });
    held = null;
    act(() => owner.resume());
    await act(async () => {});
    expect(screen.getByText('3')).toBeOnTheScreen();
    act(() => oldRefresh());
    await act(async () => {});
    expect(reads).toBe(3);
    view.unmount();
  });

  it('does not perform an expired stack reread or arm its timer after the captured scope retires', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    function Probe() {
      const value = useStackSnapshot(async core => {
        reads++;
        await core.db.getFirstAsync('SELECT count(*) FROM boards');
        await held;
        return ok({ generatedAtUtc: core.clock.nowUtcMs(), refreshAtUtc: core.clock.nowUtcMs() - 1 });
      }, 'retained');
      return <Text>{value.status}</Text>;
    }
    const view = render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    await act(async () => {});
    let join!: Promise<void>;
    act(() => { join = owner.suspend(); });
    await act(async () => { release(); await join; jest.advanceTimersByTime(120_000); });
    expect(reads).toBe(1);
    view.unmount();
  });

  it('keeps actual ledger pages visible and denies a previous load-more closure after resume', async () => {
    const board = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Coins', kind: 'count',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
      startOfDayMinute: 0, metricsEnabled: true, earnsCoins: true, coinCapPerDay: 3 });
    if (!board.ok) throw Error(board.error.message);
    for (let i = 0; i < 3; i++) {
      const result = await createCheckIn(harness.deps, { commandId: harness.ids.nextCommandId(), boardId: board.value.boardId, source: 'app' });
      expect(result.ok).toBe(true);
    }
    const actual = coinQueries.getCoinHistoryPage;
    const query = jest.spyOn(coinQueries, 'getCoinHistoryPage').mockImplementation((core, input) => actual(core, { ...input, limit: 1 }));
    let latest!: ReturnType<typeof useCoinHistory>;
    function Probe() { latest = useCoinHistory(); return <Text>{latest.items.length}</Text>; }
    const view = render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    await act(async () => {});
    expect(latest.items).toHaveLength(1);
    const oldMore = latest.loadMore, oldRefresh = latest.refresh;
    await act(async () => { await owner.suspend(); });
    act(() => { oldMore(); oldRefresh(); });
    await act(async () => {});
    expect(query).toHaveBeenCalledTimes(1);
    expect(latest.items).toHaveLength(1);
    act(() => owner.resume());
    await act(async () => {});
    act(() => { oldMore(); oldRefresh(); });
    await act(async () => {});
    expect(query).toHaveBeenCalledTimes(2);
    act(() => latest.loadMore());
    await act(async () => {});
    expect(latest.items).toHaveLength(2);
    view.unmount();
  });

  it('does not rearm a previous stack snapshot while its fresh resumed query is still pending', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    function Probe() {
      const state = useStackSnapshot(async core => {
        reads++;
        if (reads > 1) await held;
        await core.db.getFirstAsync('SELECT count(*) FROM boards');
        return ok({ generatedAtUtc: core.clock.nowUtcMs(), refreshAtUtc: core.clock.nowUtcMs() + 100 });
      }, 'same-key');
      return <Text>{state.status}</Text>;
    }
    const view = render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    await act(async () => {});
    await act(async () => { await owner.suspend(); });
    harness.clock.advanceMinutes(1);
    act(() => owner.resume());
    await act(async () => {});
    act(() => jest.advanceTimersByTime(500));
    const beforeResolution = reads;
    await act(async () => { release(); });
    expect(beforeResolution).toBe(2);
    view.unmount();
  });
});
