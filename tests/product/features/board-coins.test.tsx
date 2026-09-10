import { observeProductCore } from '@/testing/observe-product-core';
import { act, within } from '@testing-library/react-native';
import { Switch } from '@expo/ui';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import * as boardCreation from '@/core/domain/create-board-with-reminders';
import type { BoardId } from '@/core/domain/ids';
import { getBoard, listActiveBoards } from '@/core/domain/queries';
import { getDraftState } from '@/features/board-configuration/draft-store';
import { CoinCapPicker } from '@/features/board-configuration/coin-cap-picker';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

let renderedCore: ReturnType<typeof observeProductCore>;
afterEach(() => renderedCore.restore());

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}
async function stored(boardId: BoardId) {
  const result = await getBoard(await core(), boardId);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function newForm() {
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('create-board');
  await press('create-board');
  await screen.findByTestId('board-title-input');
}
async function toggle(enabled: boolean) {
  fireEvent(screen.getByRole('switch', { name: 'Earn Coins' }), 'valueChange', enabled);
  await settle();
}
async function cap(value: number) {
  fireEvent(screen.getByRole('combobox', { name: 'Daily Coin Cap' }), 'selectionChange', value);
  await settle();
}
async function existingBoard() {
  const c = await core();
  const result = await createBoard(c, {
    commandId: newCommandId(), title: 'Read', kind: 'count', symbol: 'star.fill', accentHex: '#70A7FF',
    usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  await c.db.runAsync('UPDATE boards SET earns_coins = 1, coin_cap_per_day = 4 WHERE id = ?', [result.value.boardId]);
  return result.value.boardId;
}

describe('board earning controls', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); renderedCore = observeProductCore(); });

  it('starts disabled with cap one and does not change persistence while editing', async () => {
    await newForm();
    expect(screen.getByRole('switch', { name: 'Earn Coins' }).props.value).toBe(false);
    expect(screen.queryByRole('combobox', { name: 'Daily Coin Cap' })).toBeNull();
    expect(getDraftState(renderedCore.for(await core())).draft).toMatchObject({ earnsCoins: false, coinCapPerDay: 1, dirty: false });
    await toggle(true);
    const picker = screen.getByRole('combobox', { name: 'Daily Coin Cap' });
    expect(picker).toHaveAccessibilityValue({ text: '1' });
    expect(within(picker).getAllByText(/^(?:[1-9]|10)$/)).toHaveLength(10);
    expect(await listActiveBoards(await core())).toEqual({ ok: true, value: [] });
  });

  it.each([['daily', 3], ['count', 10]] as const)('saves and reopens %s with cap %i through the normal form', async (kind, value) => {
    await newForm();
    fireEvent.changeText(screen.getByTestId('board-title-input'), `Earn ${kind}`);
    fireEvent(screen.getByTestId('board-kind-picker'), 'selectionChange', kind);
    await toggle(true);
    await cap(value);
    await press('board-form-save');
    const rows = await listActiveBoards(await core());
    if (!rows.ok) throw new Error(rows.error.message);
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]).toMatchObject({ kind, earnsCoins: true, coinCapPerDay: value });
    act(() => router.push(`/boards/${rows.value[0].id}/edit`));
    await screen.findByTestId('board-title-input');
    await settle();
    expect(screen.getByRole('switch', { name: 'Earn Coins' }).props.value).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Daily Coin Cap' })).toHaveAccessibilityValue({ text: String(value) });
    expect(await (await core()).db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });

  it('retains the cap through disabling, kind changes and Options navigation', async () => {
    await newForm();
    await toggle(true);
    await cap(6);
    await toggle(false);
    fireEvent(screen.getByTestId('board-kind-picker'), 'selectionChange', 'count');
    await press('open-options');
    act(() => router.back());
    await settle();
    await toggle(true);
    expect(screen.getByRole('combobox', { name: 'Daily Coin Cap' })).toHaveAccessibilityValue({ text: '6' });
    expect(getDraftState(renderedCore.for(await core())).draft).toMatchObject({ kind: 'count', earnsCoins: true, coinCapPerDay: 6 });
  });

  it('loads saved earning values and preserves the cap when earnings are turned off', async () => {
    const boardId = await existingBoard();
    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('edit-board');
    await press('edit-board');
    await screen.findByTestId('board-title-input');
    expect(screen.getByRole('switch', { name: 'Earn Coins' }).props.value).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Daily Coin Cap' })).toHaveAccessibilityValue({ text: '4' });
    await toggle(false);
    await press('board-form-save');
    expect(await stored(boardId)).toMatchObject({ earnsCoins: false, coinCapPerDay: 4 });
  });

  it('discards unsaved earning changes through the existing dirty-form confirmation', async () => {
    const boardId = await existingBoard();
    const before = await stored(boardId);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('edit-board');
    await press('edit-board');
    await screen.findByTestId('board-title-input');
    await cap(10);
    const alert = jest.spyOn(Alert, 'alert');
    await press('board-form-cancel');
    const discard = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Discard');
    expect(discard).toBeDefined();
    act(() => discard?.onPress?.());
    await settle();
    expect(await stored(boardId)).toEqual(before);
  });

  it('ignores queued control callbacks during a pending save and retains failed-save values for retry', async () => {
    await newForm();
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Keep my cap');
    await toggle(true);
    await cap(7);
    let finish!: (result: Awaited<ReturnType<typeof boardCreation.createBoardWithReminders>>) => void;
    const save = jest.spyOn(boardCreation, 'createBoardWithReminders').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const changeCap = screen.UNSAFE_getByType(CoinCapPicker).props.onChange;
    const changeEarnings = screen.UNSAFE_getAllByType(Switch).find(control => control.props.label === 'Earn Coins')!.props.onValueChange;
    await press('board-form-save');
    const captured = save.mock.calls[0][1];
    expect(captured).toMatchObject({ earnsCoins: true, coinCapPerDay: 7 });
    expect(screen.getByText('Saving board...')).toBeOnTheScreen();
    expect(screen.getByTestId('board-form-retry')).toBeDisabled();
    expect(screen.queryByRole('switch', { name: 'Earn Coins' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Daily Coin Cap' })).toBeNull();
    act(() => {
      changeCap(2);
      changeEarnings(false);
    });
    expect(getDraftState(renderedCore.for(await core())).draft).toMatchObject({ earnsCoins: true, coinCapPerDay: 7 });
    await act(async () => finish({ ok: false, error: { code: 'database', message: 'Temporary save failure', retryable: true } }));
    await settle();
    expect(screen.getByText('Temporary save failure')).toBeTruthy();
    expect(screen.getByTestId('board-form-retry')).toBeEnabled();
    expect(screen.queryByRole('switch', { name: 'Earn Coins' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Daily Coin Cap' })).toBeNull();
    act(() => { changeCap(2); changeEarnings(false); });
    expect(getDraftState(renderedCore.for(await core())).draft).toMatchObject({ earnsCoins: true, coinCapPerDay: 7 });
    expect(await listActiveBoards(await core())).toEqual({ ok: true, value: [] });
    await press('board-form-retry');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual(captured);
    const saved = await listActiveBoards(await core());
    expect(saved).toMatchObject({ ok: true, value: [{ title: 'Keep my cap', earnsCoins: true, coinCapPerDay: 7 }] });
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value).toHaveLength(1);
  });
});
