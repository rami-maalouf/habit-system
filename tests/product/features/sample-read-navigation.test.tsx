import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, useLocalSearchParams, type Href } from 'expo-router';
import { Text } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import * as queries from '@/core/domain/queries';
import { AnalyticsScreen } from '@/features/analytics/analytics-screen';
import { JournalScreen } from '@/features/journal/journal-screen';
import { CoinBalancePill } from '@/features/coins/coin-balance-pill';
import { CoinsScreen } from '@/features/coins/coins-screen';
import { CoinHistoryScreen } from '@/features/coins/coin-history-screen';
import { StackListScreen } from '@/features/stacks/stack-list-screen';
import { StackDetailScreen } from '@/features/stacks/stack-detail-screen';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { ProductPressable, RecoveryScreen } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('real notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('real widgets evaluated'); });

const missing = '00000000-0000-4000-8000-999999999999';

describe('sample destinations in read screens', () => {
  let harness: TestHarness;
  let owner: OperationOwner;
  let boardId: BoardId;
  beforeEach(async () => {
    harness = await createTestHarness();
    owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    boardId = await board('Practice');
  });
  afterEach(async () => { cleanup(); jest.restoreAllMocks(); await harness.db.closeAsync(); });
  async function board(title: string, anchored = false) {
    const result = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title, kind: 'count',
      symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false,
      startOfDayMinute: 0, metricsEnabled: true, earnsCoins: true, coinCapPerDay: 10,
      ...(anchored ? { anchor: { kind: 'preset' as const, relation: 'after' as const, preset: 'wake' as const } } : {}) });
    if (!result.ok) throw Error(result.error.message);
    return result.value.boardId;
  }
  async function check(note?: string, logicalDate?: LogicalDate) {
    const result = await createCheckIn(harness.deps, { commandId: harness.ids.nextCommandId(), boardId, source: 'app', note, logicalDate });
    if (!result.ok) throw Error(result.error.message);
    return result.value.checkInId;
  }
  function Root() { return <ThemeProvider value={DefaultTheme}><Stack /></ThemeProvider>; }
  function Sample() { return <ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider>; }
  function Analytics() { return <AnalyticsScreen boardId={useLocalSearchParams<{ boardId: BoardId }>().boardId} />; }
  function Journal() { return <JournalScreen boardId={useLocalSearchParams<{ boardId: BoardId }>().boardId} />; }
  function Detail() { return <StackDetailScreen rootId={useLocalSearchParams<{ rootId: BoardId }>().rootId} />; }
  async function open(path: string) {
    renderRouter({ _layout: Root, index: () => <Text>Real home</Text>,
      'sample/_layout': Sample, 'sample/index': CoinBalancePill,
      'sample/coins/index': CoinsScreen, 'sample/coins/history': CoinHistoryScreen,
      'sample/boards/new': () => <Text>Sample board form destination</Text>,
      'sample/boards/[boardId]/analytics': Analytics, 'sample/boards/[boardId]/journal': Journal,
      'sample/boards/[boardId]/check-ins/new': () => <Text>Sample new check destination</Text>,
      'sample/boards/[boardId]/check-ins/[checkInId]': () => <Text>Sample edit check destination</Text>,
      'sample/stacks/index': StackListScreen, 'sample/stacks/[rootId]': Detail,
      'sample/recover': () => <RecoveryScreen message="This link is not valid." />,
      '+not-found': () => <Text>Escaped the sample route map</Text>,
    }, { initialUrl: path });
    await settle();
  }
  async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
  async function pressLabel(label: string) { fireEvent.press(screen.getByRole('button', { name: label })); await settle(); }
  function callback(id: string) {
    const control = screen.UNSAFE_getAllByType(ProductPressable).find(item => item.props.testID === id);
    if (!control) throw Error(`missing ${id}`);
    return control.props.onPress as () => void;
  }
  async function retireAndResume() {
    await act(async () => { await owner.suspend(); }); await settle();
    act(() => owner.resume()); await settle();
  }

  it.each(['analytics', 'journal'])('keeps unavailable %s recovery inside sample', async route => {
    await open(`/sample/boards/${missing}/${route}`);
    expect(screen.getByText('This board is not available.')).toBeOnTheScreen();
    await pressLabel('Back to Boards');
    expect(screen).toHavePathname('/sample');
    expect(screen.queryByText('Real home')).toBeNull();
  });

  it('keeps the shared product recovery surface inside sample', async () => {
    await open('/sample/recover');
    const stale = callback('recovery-home');
    await retireAndResume();
    act(stale); await settle();
    expect(screen).toHavePathname('/sample/recover');
    await press('recovery-home');
    expect(screen).toHavePathname('/sample');
  });

  it('opens a new check from an empty journal and denies its old callback after retirement', async () => {
    const path = `/sample/boards/${boardId}/journal`;
    await open(path);
    const stale = callback('journal-add-check-in');
    await retireAndResume();
    act(stale); await settle();
    expect(screen).toHavePathname(path);
    await press('journal-add-check-in');
    expect(screen).toHavePathname(`/sample/boards/${boardId}/check-ins/new`);
  });

  it('opens the exact actual note token inside the sample check-in route', async () => {
    const checkInId = await check('A retained sample note');
    await open(`/sample/boards/${boardId}/journal`);
    expect(screen.getByText('A retained sample note')).toBeOnTheScreen();
    await press(`journal-entry-${checkInId}`);
    expect(screen).toHavePathname(`/sample/boards/${boardId}/check-ins/${checkInId}`);
  });

  it('keeps actual coin totals and history in sample while old pill/history callbacks stay retired', async () => {
    await check(); await open('/sample');
    const pill = callback('coin-balance-pill');
    await retireAndResume();
    act(pill); await settle();
    expect(screen).toHavePathname('/sample');
    await press('coin-balance-pill');
    expect(screen).toHavePathname('/sample/coins');
    expect(screen.getByTestId('coins-balance')).toHaveTextContent('1');
    const history = callback('coins-history-link');
    await retireAndResume();
    act(history); await settle();
    expect(screen).toHavePathname('/sample/coins');
    await press('coins-history-link');
    expect(screen).toHavePathname('/sample/coins/history');
    expect(screen.getByText('Practice')).toBeOnTheScreen();
  });

  it('scopes empty stack creation and ignores the old create callback after retirement', async () => {
    await open('/sample/stacks');
    expect(screen.getByTestId('stacks-empty')).toBeOnTheScreen();
    const stale = callback('stacks-create-board');
    await retireAndResume();
    act(stale); await settle();
    expect(screen).toHavePathname('/sample/stacks');
    await press('stacks-create-board');
    expect(screen).toHavePathname('/sample/boards/new');
  });

  it('opens an actual derived stack and returns its missing-detail recovery to sample stacks', async () => {
    const rootId = await board('Anchored practice', true);
    await open('/sample/stacks');
    const stale = callback(`stack-card-${rootId}`);
    await retireAndResume();
    act(stale); await settle();
    expect(screen).toHavePathname('/sample/stacks');
    await press(`stack-card-${rootId}`);
    expect(screen).toHavePathname(`/sample/stacks/${rootId}`);
    expect(screen.getByTestId('stack-detail')).toBeOnTheScreen();
    act(() => router.push(`/sample/stacks/${missing}` as Href)); await settle();
    expect(screen.getByTestId('stack-error')).toBeOnTheScreen();
    await pressLabel('Back to Stacks');
    expect(screen).toHavePathname('/sample/stacks');
  });

  it('keeps retained analytics selection unchanged when an old year callback runs after resume', async () => {
    await check(undefined, '2025-12-30' as LogicalDate);
    await open(`/sample/boards/${boardId}/analytics`);
    expect(screen.getByTestId('timeline-year')).toHaveTextContent('2026');
    const timeline = callback('timeline-year-previous');
    const comparison = callback('comparison-year-previous');
    const read = jest.spyOn(queries, 'getTimelineAnalytics');
    await retireAndResume(); read.mockClear();
    act(() => { timeline(); comparison(); }); await settle();
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByTestId('timeline-year')).toHaveTextContent('2026');
    expect(screen.getByTestId('comparison-year')).toHaveTextContent('2026');
    await press('timeline-year-previous');
    expect(screen.getByTestId('timeline-year')).toHaveTextContent('2025');
  });
});
