import { act, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Dimensions } from 'react-native';

import { createBoard, createCheckIn, toggleDailyCheckIn } from '@/core/domain/commands';
import type { BoardId, LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import * as queries from '@/core/domain/coin-queries';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function seed(title: string, root?: BoardId) {
  const result = await createBoard(await core(), { commandId: newCommandId(), title, kind: 'daily', earnsCoins: true,
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
    ...(root ? { anchor: { kind: 'board' as const, relation: 'after' as const, boardId: root } } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
const originalWindow = Dimensions.get('window');
const originalScreen = Dimensions.get('screen');

describe('Coins routes', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16); });
  afterEach(() => { act(() => Dimensions.set({ window: originalWindow, screen: originalScreen })); });

  it('opens Coins from the balance pill, shows truthful empty states, and navigates through history and back', async () => {
    renderRouter('src/app', { initialUrl: '/' });
    expect(await screen.findByLabelText('Coin balance, 0 coins')).toBeOnTheScreen();
    await press('coin-balance-pill');
    expect(screen).toHavePathname('/coins');
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('0');
    expect(screen.getByTestId('coins-earned')).toHaveTextContent('0');
    expect(screen.getByTestId('coins-spent')).toHaveTextContent('0');
    expect(await screen.findByTestId('rewards-empty')).toBeOnTheScreen();
    expect(screen.getByTestId('create-reward')).toBeOnTheScreen();
    await press('coins-history-link');
    expect(screen).toHavePathname('/coins/history');
    expect(await screen.findByTestId('coin-history-empty')).toHaveTextContent('Your coin activity will appear here.', { exact: false });
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/coins');
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/');
  });

  it('updates the header after a real Home check and precise Undo without changing the existing controls', async () => {
    await seed('Walk');
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    await press('board-card-0-quick');
    expect(await screen.findByLabelText('Coin balance, 1 coin')).toBeOnTheScreen();
    expect(screen.getByTestId('toggle-edit-boards')).toBeOnTheScreen();
    expect(screen.getByTestId('create-board')).toBeOnTheScreen();
    await press('undo-check-in');
    expect(await screen.findByLabelText('Coin balance, 0 coins')).toBeOnTheScreen();
    await press('coin-balance-pill');
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('0');
    expect(screen.getByTestId('coins-earned')).toHaveTextContent('1');
    expect(screen.getByTestId('coins-spent')).toHaveTextContent('1');
  });

  it.each([1, 2.8])('shows the original awards, reversals and fresh completion in one exact-date history group at font scale %s', async fontScale => {
    act(() => Dimensions.set({ window: { ...originalWindow, width: 393, fontScale }, screen: originalScreen }));
    const root = await seed('Read');
    const member = await seed('Reflect', root);
    for (const boardId of [root, member]) expect((await createCheckIn(await core(), { commandId: newCommandId(), boardId, source: 'app' })).ok).toBe(true);
    for (let i = 0; i < 2; i++) expect((await toggleDailyCheckIn(await core(), { commandId: newCommandId(), boardId: member, logicalDate: '2026-09-08' as LogicalDate })).ok).toBe(true);
    const rows = await (await core()).db.getAllAsync<{ id: string }>('SELECT id FROM coin_ledger ORDER BY logical_date DESC, created_at DESC, id DESC');
    expect(rows).toHaveLength(7);
    renderRouter('src/app', { initialUrl: '/coins' });
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('3');
    expect(screen.getByTestId('coins-earned')).toHaveTextContent('5');
    expect(screen.getByTestId('coins-spent')).toHaveTextContent('2');
    fireEvent(screen.getByTestId('coins-screen'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } });
    await settle();
    await press('coins-history-link');
    await screen.findByTestId(`coin-history-row-${rows[0].id}`);
    fireEvent(screen.getByTestId('coin-history-list'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 393, height: 700 } } });
    await settle();
    const list = within(screen.getByTestId('coin-history-list'));
    expect(list.getAllByTestId(/^coin-history-row-/).map(row => row.props.testID)).toEqual(rows.map(row => `coin-history-row-${row.id}`));
    expect(list.getAllByTestId('coin-history-date-2026-09-08')).toHaveLength(1);
    expect(list.getAllByText('Stack completion bonus')).toHaveLength(2);
    expect(list.getByText('Stack bonus reversed')).toBeOnTheScreen();
    expect(list.getByText('Check-in reward reversed')).toBeOnTheScreen();
    expect(list.getAllByText('Stack rooted at Read')).toHaveLength(3);
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/coins');
    expect(screen.getByTestId('coins-balance')).toHaveTextContent('3');
  });

  it('shows a negative balance and immutable reward title even without a reward record', async () => {
    const claim: CoinLedgerRow = { id: '00000000-0000-4000-8000-000000000901' as LedgerEntryId, kind: 'claim', delta: -3,
      boardId: null, checkInId: null, runKey: null, rewardId: '00000000-0000-4000-8000-000000000902' as RewardId,
      rewardTitleSnapshot: 'A quiet afternoon', reversesId: null, scopeKey: null, sourceActionId: null,
      reconciliationKey: null, adjustsId: null, provenanceJson: null, logicalDate: '2026-09-07' as LogicalDate,
      createdAt: mockClock.utcMs, mutationStamp: '01788897600000-00000-test', deletedAt: null };
    await appendLedgerEntry((await core()).db, claim);
    renderRouter('src/app', { initialUrl: '/' });
    expect(await screen.findByLabelText('Coin balance, minus 3 coins')).toBeOnTheScreen();
    expect(screen.getByTestId('coin-balance-pill')).toHaveTextContent('-3');
    await press('coin-balance-pill');
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('-3');
    expect(screen.getByTestId('coins-spent')).toHaveTextContent('3');
    await press('coins-history-link');
    const row = await screen.findByTestId(`coin-history-row-${claim.id}`);
    expect(row).toHaveTextContent('Reward claimed', { exact: false });
    expect(row).toHaveTextContent('A quiet afternoon', { exact: false });
    expect(row).toHaveTextContent('-3', { exact: false });
    expect(row.props.accessibilityLabel).toContain('minus 3 coins');
  });

  it('reports a failed balance query instead of an invented zero, then retries', async () => {
    const query = jest.spyOn(queries, 'getCoinTotals').mockRejectedValue(new Error('temporary read failure'));
    renderRouter('src/app', { initialUrl: '/coins' });
    expect(await screen.findByTestId('coins-error')).toHaveTextContent('temporary read failure');
    expect(screen.queryByTestId('coins-balance')).toBeNull();
    query.mockRestore();
    await press('coins-retry');
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('0');
  });
});
