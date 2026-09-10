import { observeProductCore } from '@/testing/observe-product-core';
import { act, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { archiveBoard, createBoard, deleteBoard, setAnchorPresetMinute, updateBoard } from '@/core/domain/commands';
import * as commands from '@/core/domain/commands';
import type { BoardId } from '@/core/domain/ids';
import { getBoard, listActiveBoards } from '@/core/domain/queries';
import * as queries from '@/core/domain/queries';
import { getDraftState } from '@/features/board-configuration/draft-store';
import { formatMinuteOfDay } from '@/features/reminders/weekdays';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

let renderedCore: ReturnType<typeof observeProductCore>;
afterEach(() => renderedCore.restore());

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function board(title: string) {
  const result = await createBoard(await core(), { commandId: newCommandId(), title, kind: 'count', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}
async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}
async function edit(id: BoardId) {
  renderRouter('src/app', { initialUrl: `/boards/${id}` });
  await screen.findByTestId('edit-board');
  await press('edit-board');
  await screen.findByTestId('board-title-input');
  await settle();
}
async function picker() {
  await press('board-anchor-row');
  await screen.findByTestId('anchor-clear');
}
async function relation(value: 'before' | 'after') {
  fireEvent(screen.getByTestId('anchor-relation-picker'), 'selectionChange', value);
  await settle();
}
async function stored(id: BoardId) {
  const result = await getBoard(await core(), id);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('board anchor configuration', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); renderedCore = observeProductCore(); });

  it('shows habits in home order, excludes self, includes archived, and commits only after Done and board Save', async () => {
    const first = await board('First');
    const archived = await board('Archived target');
    const current = await board('Reading');
    await archiveBoard(await core(), { commandId: newCommandId(), boardId: archived });
    await edit(current);
    const before = await stored(current);
    await picker();
    expect(screen.queryByTestId(`anchor-board-${current}`)).toBeNull();
    const choices = within(screen.getByTestId('anchor-habits')).getAllByRole('button');
    expect(choices.map((choice) => choice.props.testID)).toEqual([`anchor-board-${first}`, `anchor-board-${archived}`]);
    expect(screen.getByTestId(`anchor-board-${archived}`)).toHaveTextContent(/Archived/);
    await press(`anchor-board-${archived}`);
    await relation('before');
    expect(getDraftState(renderedCore.for(await core())).draft.dirty).toBe(false);
    expect(await stored(current)).toEqual(before);
    await press('anchor-picker-cancel');
    expect(getDraftState(renderedCore.for(await core())).draft.dirty).toBe(false);
    await picker();
    await press(`anchor-board-${archived}`);
    await relation('before');
    await press('anchor-picker-done');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent('Reading before Archived target (Archived)');
    expect(await stored(current)).toEqual(before);
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ anchorKind: 'board', anchorBoardId: archived, anchorRelation: 'before' });
    act(() => router.push(`/boards/${current}/edit`));
    await settle();
    expect(await screen.findByTestId('anchor-summary')).toHaveTextContent('Reading before Archived target (Archived)');
  });

  it('uses current saved preset times, updates the sentence title and saves an After preset on a new Daily habit', async () => {
    await setAnchorPresetMinute(await core(), { commandId: newCommandId(), preset: 'wake', minute: 465 });
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('create-board');
    await press('create-board');
    await screen.findByTestId('board-title-input');
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Stretch');
    await picker();
    for (const preset of ['wake', 'lunch', 'dinner', 'sleep']) expect(screen.getByTestId(`anchor-preset-${preset}`)).toBeOnTheScreen();
    expect(screen.getByTestId('anchor-preset-wake')).toHaveTextContent(formatMinuteOfDay(465), { exact: false });
    await press('anchor-preset-wake');
    await press('anchor-picker-done');
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Morning stretch');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent('Morning stretch after Waking up');
    await press('board-form-save');
    const all = await listActiveBoards(await core());
    expect(all.ok && all.value[0]).toMatchObject({ title: 'Morning stretch', kind: 'daily', anchorKind: 'preset', anchorPreset: 'wake', anchorRelation: 'after', usualTimeMinute: null, requiredInStack: true });
  });

  it('validates trimmed Unicode text by code points, retains invalid input, and clears a saved anchor', async () => {
    const current = await board('Read');
    await edit(current);
    await picker();
    fireEvent.changeText(screen.getByTestId('anchor-text-input'), '   ');
    await press('anchor-picker-done');
    expect(screen.getByTestId('anchor-picker-error')).toHaveTextContent(/1 to 80/);
    fireEvent.changeText(screen.getByTestId('anchor-text-input'), 'x'.repeat(81));
    await press('anchor-picker-done');
    expect(screen.getByTestId('anchor-text-input').props.value).toBe('x'.repeat(81));
    const text = '𐐀'.repeat(80);
    fireEvent.changeText(screen.getByTestId('anchor-text-input'), `  ${text}  `);
    await relation('before');
    await press('anchor-picker-done');
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ anchorKind: 'text', anchorRelation: 'before', anchorText: text });
    act(() => router.push(`/boards/${current}/edit`));
    await settle();
    await picker();
    await press('anchor-clear');
    await press('anchor-picker-done');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent('No anchor');
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ anchorKind: null, anchorRelation: null, anchorBoardId: null, anchorPreset: null, anchorText: null });
  });

  it('keeps usual time and false membership through kind and Options changes, saves and clears the optional time', async () => {
    const current = await board('Walk');
    await edit(current);
    expect(screen.getByTestId('usual-time-row')).toHaveTextContent(/Not set/);
    await press('usual-time-row');
    const time = screen.getByRole('combobox', { name: 'Usual time' });
    expect(within(time).getAllByText(/\d/)).toHaveLength(96);
    fireEvent(time, 'selectionChange', 1425);
    await press('usual-time-done');
    fireEvent(screen.getByRole('switch', { name: 'Required in stack' }), 'valueChange', false);
    fireEvent(screen.getByTestId('board-kind-picker'), 'selectionChange', 'daily');
    await press('open-options');
    act(() => router.back());
    await settle();
    expect(screen.getByTestId('usual-time-row')).toHaveTextContent(formatMinuteOfDay(1425), { exact: false });
    expect(screen.getByRole('switch', { name: 'Required in stack' }).props.value).toBe(false);
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ kind: 'daily', usualTimeMinute: 1425, requiredInStack: false });
    act(() => router.push(`/boards/${current}/edit`));
    await settle();
    expect(await screen.findByTestId('usual-time-row')).toHaveTextContent(formatMinuteOfDay(1425), { exact: false });
    await press('usual-time-row');
    await press('usual-time-clear');
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ usualTimeMinute: null, requiredInStack: false });
  });

  it('sets midnight explicitly without a wheel change and cancels local time edits without dirtying the form', async () => {
    const current = await board('Midnight');
    await edit(current);
    await press('usual-time-row');
    expect(getDraftState(renderedCore.for(await core())).draft.dirty).toBe(false);
    expect((await stored(current)).usualTimeMinute).toBeNull();
    fireEvent(screen.getByTestId('usual-time-picker'), 'selectionChange', 465);
    await press('usual-time-cancel');
    expect(getDraftState(renderedCore.for(await core())).draft.dirty).toBe(false);
    await press('usual-time-row');
    await press('usual-time-done');
    expect(getDraftState(renderedCore.for(await core())).draft.usualTimeMinute).toBe(0);
    expect((await stored(current)).usualTimeMinute).toBeNull();
    await press('board-form-save');
    expect((await stored(current)).usualTimeMinute).toBe(0);
  });

  it('dismisses sheet edits and outer form drafts without persistence', async () => {
    const current = await board('Keep');
    const before = await stored(current);
    await edit(current);
    await picker();
    await press('anchor-preset-lunch');
    fireEvent(screen.getByTestId('anchor-picker-sheet'), 'accessibilityEscape');
    await settle();
    expect(getDraftState(renderedCore.for(await core())).draft.dirty).toBe(false);
    await picker();
    await press('anchor-preset-dinner');
    await press('anchor-picker-done');
    const alert = jest.spyOn(Alert, 'alert');
    await press('board-form-cancel');
    const discard = alert.mock.calls.at(-1)?.[2]?.find((button) => button.text === 'Discard');
    expect(discard).toBeDefined();
    act(() => discard?.onPress?.());
    await settle();
    expect(await stored(current)).toEqual(before);
  });

  it('rejects a cycle on Save without changing boards and allows a corrected retry', async () => {
    const current = await board('Root');
    const child = await board('Child');
    const childRow = await stored(child);
    expect((await updateBoard(await core(), { ...childRow, commandId: newCommandId(), boardId: child, expectedMutationStamp: childRow.mutationStamp, anchor: { kind: 'board', relation: 'after', boardId: current } })).ok).toBe(true);
    const before = await stored(current);
    await edit(current);
    await picker();
    await press(`anchor-board-${child}`);
    await press('anchor-picker-done');
    await press('board-form-save');
    expect(screen.getByTestId('board-form-error')).toHaveTextContent(/back to itself/);
    expect(await stored(current)).toEqual(before);
    await picker();
    await press('anchor-preset-sleep');
    await press('anchor-picker-done');
    await press('board-form-save');
    expect(await stored(current)).toMatchObject({ anchorKind: 'preset', anchorPreset: 'sleep' });
  });

  it('handles deletion of a selected target and storage failure without silently changing the selected anchor', async () => {
    const target = await board('Target');
    const current = await board('Current');
    await edit(current);
    await picker();
    await press(`anchor-board-${target}`);
    await press('anchor-picker-done');
    await deleteBoard(await core(), { commandId: newCommandId(), boardId: target });
    await press('board-form-save');
    expect(screen.getByTestId('board-form-error')).toHaveTextContent(/no longer exists/);
    expect((await stored(current)).anchorKind).toBeNull();
    await picker();
    await press('anchor-preset-lunch');
    await press('anchor-picker-done');
    const save = jest.spyOn(commands, 'updateBoard');
    const fail = jest.spyOn((await core()).db, 'runAsync').mockRejectedValueOnce(new Error('simulated disk failure'));
    await press('board-form-save');
    expect(screen.getByTestId('board-form-error')).toHaveTextContent(/simulated disk failure/);
    expect(screen.queryByTestId('anchor-summary')).toBeNull();
    expect(screen.getByTestId('board-form-retry')).toBeOnTheScreen();
    const captured = save.mock.calls[0][1];
    expect(captured.anchor).toEqual({ kind: 'preset', relation: 'after', preset: 'lunch' });
    fail.mockRestore();
    await press('board-form-retry');
    expect(save.mock.calls).toHaveLength(2);
    expect(save.mock.calls[1][1]).toEqual(captured);
    expect(await stored(current)).toMatchObject({ anchorKind: 'preset', anchorPreset: 'lunch' });
  });

  it('shows a recoverable saved-target read error and refreshes a renamed target after selection', async () => {
    const target = await board('Old title');
    const current = await board('Current');
    const currentRow = await stored(current);
    expect((await updateBoard(await core(), { ...currentRow, commandId: newCommandId(), boardId: current, expectedMutationStamp: currentRow.mutationStamp, anchor: { kind: 'board', relation: 'after', boardId: target } })).ok).toBe(true);
    jest.spyOn(queries, 'getAnchorPickerOptions').mockRejectedValueOnce(new Error('summary read failure'));
    await edit(current);
    expect(screen.getByTestId('anchor-summary-error')).toHaveTextContent(/could not be loaded/);
    expect(screen.getByTestId('anchor-summary')).not.toHaveTextContent(/Loading/);
    await press('anchor-summary-retry');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent('Current after Old title');
    const targetRow = await stored(target);
    expect((await updateBoard(await core(), { ...targetRow, title: 'New title', commandId: newCommandId(), boardId: target, expectedMutationStamp: targetRow.mutationStamp })).ok).toBe(true);
    await picker();
    await press(`anchor-board-${target}`);
    await press('anchor-picker-done');
    expect(screen.getByTestId('anchor-summary')).toHaveTextContent('Current after New title');
  });

  it('shows a retry for failed choices without inventing a preset time or losing the form draft', async () => {
    const current = await board('Retain me');
    await edit(current);
    jest.spyOn(queries, 'getAnchorPickerOptions').mockRejectedValueOnce(new Error('temporary read failure'));
    await press('board-anchor-row');
    expect(await screen.findByTestId('anchor-picker-load-error')).toBeOnTheScreen();
    expect(screen.queryByTestId('anchor-preset-wake')).toBeNull();
    await press('anchor-picker-retry');
    expect(await screen.findByTestId('anchor-preset-wake')).toHaveTextContent(formatMinuteOfDay(420), { exact: false });
    await press('anchor-picker-cancel');
    expect(screen.getByTestId('board-title-input').props.value).toBe('Retain me');
  });
});
