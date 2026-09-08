import { act } from '@testing-library/react-native';
import { router } from 'expo-router';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import { listActiveBoards } from '@/core/domain/queries';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { listBoardCheckInsForDate } from '@/core/persistence/repositories/check-ins';
import type { LogicalDate } from '@/core/domain/ids';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

async function chooseKind(kind: 'daily' | 'count') {
  fireEvent(screen.getByTestId('board-kind-picker'), 'selectionChange', kind);
  await settle();
}

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function back() {
  act(() => router.back());
  await settle();
}

describe('board kind configuration', () => {
  beforeEach(() => resetProductCoreForTests());

  it('defaults to Daily, hides Count controls, and saves and reopens that kind', async () => {
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('create-board');
    await press('create-board');
    const picker = await screen.findByTestId('board-kind-picker');
    expect(picker).toHaveAccessibilityValue({ text: 'Daily' });
    expect(screen.getByRole('combobox', { name: 'Kind' })).toBeOnTheScreen();
    expect(screen.getByTestId('board-kind-preview')).toHaveTextContent('Daily habit');
    expect(screen.queryByTestId('amounts-toggle')).toBeNull();
    expect(screen.queryByTestId('unit-input')).toBeNull();
    expect(screen.queryByTestId('quick-amount-input')).toBeNull();
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'morning walk');
    await press('open-options');
    expect(screen.queryByTestId('track-time-toggle')).toBeNull();
    expect(screen.getByTestId('start-of-day-value')).toBeOnTheScreen();
    await back();
    await press('board-form-save');
    const boards = await listActiveBoards(await core());
    expect(boards.ok && boards.value[0]).toMatchObject({ kind: 'daily', tracksAmount: false, tracksTime: false });
    fireEvent.press(screen.getByText('morning walk'));
    await settle();
    await press('edit-board');
    expect(await screen.findByTestId('board-kind-picker')).toHaveAccessibilityValue({ text: 'Daily' });
    expect(screen.queryByTestId('amounts-toggle')).toBeNull();
  });

  it('offers Count amount and time controls and retains the saved kind on edit', async () => {
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('create-board');
    await press('create-board');
    await screen.findByTestId('board-kind-picker');
    await chooseKind('count');
    expect(screen.getByTestId('board-kind-preview')).toHaveTextContent('Count board');
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'water');
    fireEvent(screen.getByTestId('amounts-toggle'), 'valueChange', true);
    await settle();
    fireEvent.changeText(screen.getByTestId('unit-input'), 'cups');
    fireEvent.changeText(screen.getByTestId('quick-amount-input'), '2.5');
    await press('open-options');
    fireEvent(screen.getByTestId('track-time-toggle'), 'valueChange', true);
    await back();
    await press('board-form-save');
    const boards = await listActiveBoards(await core());
    expect(boards.ok && boards.value[0]).toMatchObject({ kind: 'count', tracksAmount: true, tracksTime: true, amountUnit: 'cups', quickAmount: 2.5 });
    fireEvent.press(screen.getByText('water'));
    await settle();
    await press('edit-board');
    expect(await screen.findByTestId('board-kind-picker')).toHaveAccessibilityValue({ text: 'Count' });
    expect(screen.getByTestId('quick-amount-input').props.value).toBe('2.5');
  });

  it('converts Count to Daily without saving hidden invalid amounts or changing historical records', async () => {
    const deps = await core();
    const board = await createBoard(deps, { commandId: newCommandId(), kind: 'count', title: 'reading', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true, tracksAmount: true, amountUnit: 'pages', quickAmount: 3, tracksTime: true, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw new Error(board.error.message);
    const boardId = board.value.boardId;
    const date = '2026-08-30' as LogicalDate;
    for (const note of ['first note', 'second note']) {
      expect((await createCheckIn(deps, { commandId: newCommandId(), boardId, logicalDate: date, source: 'app', note })).ok).toBe(true);
    }
    const history = await listBoardCheckInsForDate(deps.db, boardId, date);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('edit-board');
    await press('edit-board');
    await screen.findByTestId('board-kind-picker');
    fireEvent.changeText(screen.getByTestId('quick-amount-input'), 'invalid');
    fireEvent.changeText(screen.getByTestId('unit-input'), 'x'.repeat(1000));
    await chooseKind('daily');
    expect(screen.queryByTestId('amounts-toggle')).toBeNull();
    await press('board-form-save');
    expect(screen.queryByTestId('board-form-error')).toBeNull();
    expect(await getBoardById(deps.db, boardId)).toMatchObject({ kind: 'daily', tracksAmount: false, tracksTime: false, amountUnit: 'pages', quickAmount: 3 });
    expect(await listBoardCheckInsForDate(deps.db, boardId, date)).toEqual(history);
  });

  it('retains unsaved Count settings when switching to Daily and back through Options', async () => {
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('create-board');
    await press('create-board');
    await screen.findByTestId('board-kind-picker');
    await chooseKind('count');
    fireEvent(screen.getByTestId('amounts-toggle'), 'valueChange', true);
    await settle();
    fireEvent.changeText(screen.getByTestId('unit-input'), 'pages');
    fireEvent.changeText(screen.getByTestId('quick-amount-input'), '12');
    await press('open-options');
    fireEvent(screen.getByTestId('track-time-toggle'), 'valueChange', true);
    await back();
    await chooseKind('daily');
    expect(screen.queryByTestId('amount-config')).toBeNull();
    await press('open-options');
    expect(screen.queryByTestId('track-time-toggle')).toBeNull();
    await back();
    await chooseKind('count');
    expect(screen.getByTestId('amounts-toggle').props.value).toBe(true);
    expect(screen.getByTestId('unit-input').props.value).toBe('pages');
    expect(screen.getByTestId('quick-amount-input').props.value).toBe('12');
    await press('open-options');
    expect(screen.getByTestId('track-time-toggle').props.value).toBe(true);
  });
});
