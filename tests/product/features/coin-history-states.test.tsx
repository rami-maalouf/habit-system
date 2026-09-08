import { act, within } from '@testing-library/react-native';
import { SectionList } from 'react-native';

import type { CoinHistoryItem, CoinTotals } from '@/core/domain/coin-queries';
import * as queries from '@/core/domain/coin-queries';
import type { BoardId, LedgerEntryId, LogicalDate } from '@/core/domain/ids';
import { ok } from '@/core/domain/result';

import { resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

const row = (n: number, fields: Partial<CoinHistoryItem> = {}): CoinHistoryItem => ({
  id: `00000000-0000-5000-8000-${String(n).padStart(12, '0')}` as LedgerEntryId,
  kind: 'adjustment', delta: 1, logicalDate: '2026-09-08' as LogicalDate, createdAt: n,
  reference: { kind: 'habit', id: '00000000-0000-4000-8000-000000000100' as BoardId, title: null, status: 'missing' },
  adjustment: 'correction', ...fields,
});
const cursor = (item: CoinHistoryItem) => ({ id: item.id, logicalDate: item.logicalDate, createdAt: item.createdAt });

describe('coin history presentation and page boundaries', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); });

  it('explains positive corrections and cancellations distinctly, including an empty-title remote tombstone', async () => {
    const restored = row(4);
    const canceled = row(3, { adjustment: 'cancellation' });
    const corrected = row(2, { delta: -1, reference: { kind: 'stack', id: '00000000-0000-4000-8000-000000000101' as BoardId, title: '', status: 'deleted' } });
    const archived = row(1, { kind: 'check', adjustment: null, reference: { kind: 'habit', id: '00000000-0000-4000-8000-000000000102' as BoardId, title: 'Stretch', status: 'archived' } });
    jest.spyOn(queries, 'getCoinHistoryPage').mockResolvedValue(ok({ items: [restored, canceled, corrected, archived], nextCursor: null }));
    renderRouter('src/app', { initialUrl: '/coins/history' });
    const first = await screen.findByTestId(`coin-history-row-${restored.id}`);
    expect(first).toHaveTextContent('Coins restored', { exact: false });
    expect(first).toHaveTextContent('Unavailable habit', { exact: false });
    expect(first.props.accessibilityLabel).toContain('1 coin');
    const cancellation = screen.getByTestId(`coin-history-row-${canceled.id}`);
    expect(cancellation).toHaveTextContent('Earlier balance adjustment undone', { exact: false });
    expect(within(cancellation).queryByText('Coins restored')).toBeNull();
    expect(screen.getByTestId(`coin-history-row-${corrected.id}`)).toHaveTextContent('Unavailable stack (Deleted)', { exact: false });
    expect(screen.getByTestId(`coin-history-row-${archived.id}`)).toHaveTextContent('Stretch (Archived)', { exact: false });
  });

  it('merges a logical date split across pages, retains ordering, and formats year 0001 without remapping', async () => {
    const first = [row(9), row(8)];
    const second = [row(7), row(6, { logicalDate: '0001-01-02' as LogicalDate })];
    const query = jest.spyOn(queries, 'getCoinHistoryPage').mockResolvedValueOnce(ok({ items: first, nextCursor: cursor(first[1]) }))
      .mockResolvedValueOnce(ok({ items: second, nextCursor: null }));
    renderRouter('src/app', { initialUrl: '/coins/history' });
    await screen.findByTestId(`coin-history-row-${first[0].id}`);
    fireEvent(screen.UNSAFE_getByType(SectionList), 'endReached');
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual({ before: cursor(first[1]) });
    expect(screen.getAllByTestId('coin-history-date-2026-09-08')).toHaveLength(1);
    expect(screen.getByTestId('coin-history-date-0001-01-02')).toHaveTextContent('January 2, 0001');
    expect(screen.getAllByTestId(/^coin-history-row-/).map(item => item.props.testID)).toEqual([...first, ...second].map(item => `coin-history-row-${item.id}`));
  });

  it('shows and retries a failed first-page read without claiming the history is empty', async () => {
    const query = jest.spyOn(queries, 'getCoinHistoryPage').mockRejectedValue(new Error('history unavailable'));
    renderRouter('src/app', { initialUrl: '/coins/history' });
    expect(await screen.findByTestId('coin-history-error')).toHaveTextContent('history unavailable');
    expect(screen.queryByTestId('coin-history-empty')).toBeNull();
    query.mockRestore();
    fireEvent.press(screen.getByTestId('coin-history-retry')); await settle();
    expect(await screen.findByTestId('coin-history-empty')).toBeOnTheScreen();
  });

  it('keeps the loading pill truthful and exposes the complete signed balance after it resolves', async () => {
    let finish!: (value: ReturnType<typeof ok<CoinTotals>>) => void;
    jest.spyOn(queries, 'getCoinTotals').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderRouter('src/app', { initialUrl: '/' });
    expect(await screen.findByLabelText('Coin balance loading')).toBeOnTheScreen();
    expect(screen.getByTestId('coin-balance-pill')).toHaveTextContent('Coins');
    await act(async () => { finish(ok({ earned: 0, spent: 1234567890123456, balance: -1234567890123456 })); });
    expect(await screen.findByLabelText('Coin balance, minus 1234567890123456 coins')).toBeOnTheScreen();
    expect(screen.getByTestId('coin-balance-pill')).toHaveTextContent('-1234567890123456');
  });
});
