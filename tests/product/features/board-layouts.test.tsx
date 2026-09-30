import { FlatList, useWindowDimensions } from 'react-native';
import { createBoard, createCheckIn } from '@/core/domain/commands';
import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

jest.mock('expo-sqlite/kv-store', () => ({
  getItem: jest.fn(async () => 'compact'),
  setItem: jest.fn(async () => undefined),
}));

async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }

beforeEach(() => { resetProductCoreForTests(); jest.clearAllMocks(); });

it('applies one layout to daily and count habits and closes the live picker from either control', async () => {
  const result = await getProductCore();
  if (!result.ok) throw new Error('core unavailable');
  for (const kind of ['daily', 'count'] as const) {
    const board = await createBoard(result.value, { commandId: newCommandId(), kind, title: kind === 'daily' ? 'read' : 'a very long habit title that should not choose its own layout',
      symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: true, tracksAmount: false,
      amountUnit: null, quickAmount: 1, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw new Error('board unavailable');
    if (kind === 'count') {
      for (let index = 0; index < 2; index += 1) {
        await createCheckIn(result.value, { commandId: newCommandId(), boardId: board.value.boardId, source: 'app' });
      }
    }
  }
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('board-card-1');
  expect(screen.getByTestId('board-card-0')).toHaveStyle({ flexDirection: 'row' });
  expect(screen.getByTestId('board-card-1')).toHaveStyle({ flexDirection: 'row' });
  expect(screen.getAllByTestId(/board-card-0-bar-\d+$/)).toHaveLength(14);
  expect(screen.getAllByTestId(/board-card-1-bar-\d+$/)).toHaveLength(14);
  await press('open-board-layout');
  await press('layout-grid');
  expect(screen.getByTestId('board-card-0')).toHaveStyle({ flexDirection: 'column' });
  expect(screen.getByTestId('board-card-1')).toHaveStyle({ flexDirection: 'column' });
  expect(await screen.findByTestId('board-card-0-heatmap')).toBeOnTheScreen();
  for (const index of [0, 1]) {
    fireEvent(screen.getByTestId(`board-card-${index}-heatmap`), 'layout', { nativeEvent: { layout: { width: 150 } } });
  }
  expect(screen.getByLabelText('2026-08-30, not checked, today')).toBeOnTheScreen();
  expect(screen.getByLabelText('2026-08-30, 2 check-ins, today')).toBeOnTheScreen();
  await press('close-board-layout');
  expect(screen.queryByTestId('board-layout-picker')).toBeNull();
  await press('open-board-layout');
  await press('board-card-0-quick');
  expect(screen.queryByTestId('board-layout-picker')).toBeNull();
  expect(screen.getByRole('checkbox', { checked: true })).toBeOnTheScreen();
  expect(await screen.findByLabelText('2026-08-30, checked, today')).toBeOnTheScreen();
  await press('open-board-layout');
  expect(screen.getByTestId('undo-check-in')).toBeOnTheScreen();
  await press('undo-check-in');
  expect(screen.getByRole('checkbox', { checked: false })).toBeOnTheScreen();
  expect(screen.getByTestId('board-layout-picker')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Two-column grid', selected: true })).toBeOnTheScreen();
  await press('layout-cards');
  await press('done-board-layout');
  expect(screen.queryByTestId('board-layout-picker')).toBeNull();
  await press('open-board-layout');
  await press('layout-compact');
  expect(screen.getByTestId('board-card-0')).toHaveStyle({ flexDirection: 'row' });
  await press('layout-summary');
  for (const index of [0, 1]) {
    expect(screen.getByTestId(`board-card-${index}`)).toHaveStyle({ flexDirection: 'column' });
    expect(screen.getAllByTestId(new RegExp(`board-card-${index}-day-\\d+$`))).toHaveLength(14);
  }
  expect(screen.getByText('0/7 this week')).toBeOnTheScreen();
  expect(screen.getByText('2 check-ins in 14 days')).toBeOnTheScreen();
  await press('board-card-0-quick');
  expect(screen.getByText('1/7 this week')).toBeOnTheScreen();
  expect(screen.getByRole('checkbox', { checked: true })).toBeOnTheScreen();
  await press('undo-check-in');
  await press('board-card-1-quick');
  expect(screen.getByText('3 check-ins in 14 days')).toBeOnTheScreen();
  await press('board-card-1-quick');
  expect(screen.getByText('4 check-ins in 14 days')).toBeOnTheScreen();
  await press('undo-check-in');
  expect(screen.getByText('3 check-ins in 14 days')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Check in to a very long habit title that should not choose its own layout' })).toBeEnabled();
});

it('keeps the grid preference while making cards readable at accessibility text sizes', async () => {
  const dimensions = jest.spyOn(require('react-native'), 'useWindowDimensions') as jest.SpyInstance<ReturnType<typeof useWindowDimensions>>;
  dimensions.mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 2 });
  const storage = require('expo-sqlite/kv-store');
  storage.getItem.mockResolvedValue('grid');
  try {
    const result = await getProductCore();
    if (!result.ok) throw new Error('core unavailable');
    await createBoard(result.value, { commandId: newCommandId(), kind: 'daily', title: 'reading',
      symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: true, tracksAmount: false,
      amountUnit: null, quickAmount: 1, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    expect(screen.UNSAFE_getByType(FlatList).props.numColumns).toBe(1);
    await press('open-board-layout');
    expect(screen.getByRole('button', { name: 'Two-column grid', selected: true })).toBeOnTheScreen();
    expect(storage.setItem).not.toHaveBeenCalled();
  } finally { dimensions.mockRestore(); }
});

it('restores the saved choice after remount and leaves navigation actions available', async () => {
  const storage = require('expo-sqlite/kv-store');
  storage.getItem.mockResolvedValue('grid');
  const view = renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('empty-create-board');
  await press('open-board-layout');
  expect(screen.getByRole('button', { name: 'Two-column grid', selected: true })).toBeOnTheScreen();
  await press('layout-summary');
  expect(storage.setItem).toHaveBeenCalledWith('boards.layout', 'summary');
  storage.getItem.mockResolvedValue('summary');
  view.unmount();
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('empty-create-board');
  await press('open-board-layout');
  expect(screen.getByRole('button', { name: '14-day summary', selected: true })).toBeOnTheScreen();
  await press('done-board-layout');
  await press('open-stacks');
  expect(screen).toHavePathname('/stacks');
});

it('rolls back failed saves, keeps the chooser open, and allows retry', async () => {
  const storage = require('expo-sqlite/kv-store');
  storage.getItem.mockResolvedValue('compact');
  storage.setItem.mockRejectedValueOnce(new Error('disk full'));
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('empty-create-board');
  await press('open-board-layout');
  await press('layout-grid');
  expect(screen.getByTestId('layout-error')).toHaveTextContent(/Could not save/);
  expect(screen.getByRole('button', { name: 'Compact rows', selected: true })).toBeOnTheScreen();
  await press('layout-grid');
  expect(screen.queryByTestId('layout-error')).toBeNull();
  expect(screen.getByRole('button', { name: 'Two-column grid', selected: true })).toBeOnTheScreen();
});
