import { act } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';

import type { CoinHistoryItem } from '@/core/domain/coin-queries';
import * as queries from '@/core/domain/coin-queries';
import type { LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import { err, ok } from '@/core/domain/result';
import { ProductProvider } from '@/features/product-store';
import { useCoinHistory } from '@/features/coins/use-coin-history';
import type { ProductCore } from '@/platform/database/product-core';

import { getProductCore, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderComponent, screen, settle } from '../../../src/testing/render';

const item = (n: number): CoinHistoryItem => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as LedgerEntryId,
  kind: 'claim', delta: -1, logicalDate: '2026-09-08' as LogicalDate, createdAt: n,
  reference: { kind: 'reward', id: '00000000-0000-4000-8000-000000000999' as RewardId, title: `Reward ${n}` }, adjustment: null });
const page = (ids: number[], more = false) => {
  const items = ids.map(item);
  const last = items.at(-1)!;
  return ok({ items, nextCursor: more ? { id: last.id, logicalDate: last.logicalDate, createdAt: last.createdAt } : null });
};
const pending = () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<ReturnType<typeof page>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function Probe() {
  const state = useCoinHistory();
  return <>
    <Text testID="rows">{state.items.map(row => row.createdAt).join(',')}</Text>
    <Text testID="phase">{state.status}:{String(state.loadingMore)}</Text>
    <Text testID="error">{state.error?.message ?? state.moreError?.message ?? ''}</Text>
    <Pressable testID="more" onPress={state.loadMore}><Text>More</Text></Pressable>
    <Pressable testID="refresh" onPress={state.refresh}><Text>Refresh</Text></Pressable>
  </>;
}
async function mount() {
  const core = await getProductCore();
  if (!core.ok) throw new Error(core.error.message);
  const rendered = renderComponent(<ProductProvider coreOverride={core.value as ProductCore}><Probe /></ProductProvider>);
  await settle();
  return rendered;
}

describe('coin history request ownership', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); jest.useFakeTimers(); });

  it('deduplicates rapid end-reached callbacks and preserves rows while retrying the identical failed cursor', async () => {
    const next = pending();
    const query = jest.spyOn(queries, 'getCoinHistoryPage').mockResolvedValueOnce(page([9, 8], true))
      .mockReturnValueOnce(next.promise).mockResolvedValueOnce(page([7, 6]));
    await mount();
    fireEvent.press(screen.getByTestId('more')); fireEvent.press(screen.getByTestId('more'));
    expect(query).toHaveBeenCalledTimes(2);
    await act(async () => { next.reject(new Error('page read failed')); });
    expect(screen.getByTestId('rows')).toHaveTextContent('9,8');
    expect(screen.getByTestId('error')).toHaveTextContent('page read failed');
    fireEvent.press(screen.getByTestId('more')); await settle();
    expect(query.mock.calls[2][1]).toEqual(query.mock.calls[1][1]);
    expect(screen.getByTestId('rows')).toHaveTextContent('9,8,7,6');
    fireEvent.press(screen.getByTestId('more')); await settle();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each(['success', 'failure'])('ignores a stale page %s after refresh without unlocking a newer pending request', async outcome => {
    const old = pending(); const fresh = pending();
    const query = jest.spyOn(queries, 'getCoinHistoryPage').mockResolvedValueOnce(page([9, 8], true))
      .mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([20, 19], true)).mockReturnValueOnce(fresh.promise);
    await mount();
    fireEvent.press(screen.getByTestId('more'));
    fireEvent.press(screen.getByTestId('refresh')); await settle();
    expect(screen.getByTestId('rows')).toHaveTextContent('20,19');
    fireEvent.press(screen.getByTestId('more'));
    await act(async () => { if (outcome === 'success') old.resolve(page([7, 6])); else old.reject(new Error('stale failure')); });
    fireEvent.press(screen.getByTestId('more'));
    expect(query).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('rows')).toHaveTextContent('20,19');
    expect(screen.getByTestId('error')).toHaveTextContent('');
    expect(screen.getByTestId('phase')).toHaveTextContent('ready:true');
    await act(async () => { fresh.resolve(page([18, 17])); });
    expect(screen.getByTestId('rows')).toHaveTextContent('20,19,18,17');
  });

  it('retains visible rows on refresh failure and recovers from the newest page', async () => {
    jest.spyOn(queries, 'getCoinHistoryPage').mockResolvedValueOnce(page([9, 8], true))
      .mockResolvedValueOnce(err('database', 'refresh failed', { retryable: true })).mockResolvedValueOnce(page([20]));
    await mount();
    fireEvent.press(screen.getByTestId('refresh')); await settle();
    expect(screen.getByTestId('rows')).toHaveTextContent('9,8');
    expect(screen.getByTestId('error')).toHaveTextContent('refresh failed');
    fireEvent.press(screen.getByTestId('refresh')); await settle();
    expect(screen.getByTestId('rows')).toHaveTextContent('20');
  });

  it('ignores a first-page result after unmount and does not issue another request', async () => {
    const first = pending();
    const query = jest.spyOn(queries, 'getCoinHistoryPage').mockReturnValue(first.promise);
    const view = await mount();
    fireEvent.press(screen.getByTestId('more'));
    expect(query).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { first.resolve(page([9], true)); });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
