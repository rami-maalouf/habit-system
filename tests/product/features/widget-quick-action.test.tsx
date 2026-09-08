import { act } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { archiveBoard, createBoard, createCheckIn, deleteBoard, updateBoard, updateCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { listBoardCheckInsForDate } from '@/core/persistence/repositories/check-ins';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

const today = '2026-08-30' as LogicalDate;

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seed(kind: 'daily' | 'count' = 'daily', notes: string[] = []) {
  const deps = await core();
  const result = await createBoard(deps, {
    commandId: newCommandId(), kind: notes.length > 1 ? 'count' : kind, title: 'widget reading',
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  const boardId = result.value.boardId;
  for (const note of notes) {
    expect((await createCheckIn(deps, { commandId: newCommandId(), boardId, source: 'app', note })).ok).toBe(true);
  }
  if (notes.length > 1 && kind === 'daily') {
    const board = await getBoardById(deps.db, boardId);
    if (!board) throw new Error('missing board');
    expect((await updateBoard(deps, { ...board, commandId: newCommandId(), boardId, expectedMutationStamp: board.mutationStamp, kind: 'daily' })).ok).toBe(true);
  }
  return boardId;
}

async function checks(boardId: BoardId) {
  return listBoardCheckInsForDate((await core()).db, boardId, today);
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

describe('Daily widget fallback', () => {
  beforeEach(() => {
    resetProductCoreForTests();
    jest.restoreAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it('opens and remounts without mutation, then checks explicitly with widget provenance and precise Undo', async () => {
    const boardId = await seed();
    const first = renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    expect(screen.getByRole('button', { name: 'Check' })).toBeOnTheScreen();
    expect(await checks(boardId)).toHaveLength(0);
    first.unmount();
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    expect(await checks(boardId)).toHaveLength(0);
    await press('daily-widget-action');
    expect(await checks(boardId)).toEqual([expect.objectContaining({ source: 'widget' })]);
    expect(screen.getByRole('button', { name: 'Uncheck' })).toBeOnTheScreen();
    await press('daily-widget-undo');
    expect(await checks(boardId)).toHaveLength(0);
    expect(screen.queryByTestId('daily-widget-undo')).toBeNull();
  });

  it('confirms every retained note, cancels without mutation, then unchecks the captured group', async () => {
    const boardId = await seed('daily', ['first retained note', 'second retained note']);
    const before = await checks(boardId);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    expect(await checks(boardId)).toEqual(before);
    await press('daily-widget-action');
    expect(Alert.alert).toHaveBeenCalledWith('Uncheck widget reading?', expect.stringMatching(/2026-08-30.*2 check-ins.*2 notes/), expect.any(Array), expect.any(Object));
    act(() => { jest.mocked(Alert.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'cancel')?.onPress?.(); });
    await settle();
    expect(await checks(boardId)).toEqual(before);
    await press('daily-widget-action');
    act(() => { jest.mocked(Alert.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive')?.onPress?.(); });
    await settle();
    expect(await checks(boardId)).toHaveLength(0);
    expect(screen.queryByTestId('daily-widget-undo')).toBeNull();
  });

  it('refreshes a stale displayed state without applying the opposite action', async () => {
    const boardId = await seed();
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    expect((await createCheckIn(await core(), { commandId: newCommandId(), boardId, source: 'app', note: 'other writer' })).ok).toBe(true);
    const before = await checks(boardId);
    await press('daily-widget-action');
    expect(await checks(boardId)).toEqual(before);
    expect(screen.getByTestId('daily-widget-error')).toHaveTextContent(/changed/);
    expect(screen.getByRole('button', { name: 'Uncheck' })).toBeOnTheScreen();
  });

  it('offers the existing Add Check-In flow when an old Daily link now refers to Count', async () => {
    const boardId = await seed('count');
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-count-fallback');
    expect(screen.queryByTestId('daily-widget-action')).toBeNull();
    expect(await checks(boardId)).toHaveLength(0);
    await press('daily-widget-count-fallback');
    await screen.findByTestId('check-in-save');
    await press('check-in-save');
    expect(await checks(boardId)).toEqual([expect.objectContaining({ source: 'widget' })]);
  });

  it('opens the Daily flow for a stale Count widget link without changing completion', async () => {
    const boardId = await seed('daily', ['already complete']);
    const before = await checks(boardId);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/check-ins/new?source=widget` });
    await screen.findByTestId('daily-widget-action');
    expect(screen.getByRole('button', { name: 'Uncheck' })).toBeOnTheScreen();
    expect(screen.queryByTestId('check-in-save')).toBeNull();
    expect(await checks(boardId)).toEqual(before);
  });

  it('keeps the captured date when midnight passes during a note prompt', async () => {
    const boardId = await seed('daily', ['yesterday note']);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    await press('daily-widget-action');
    const confirm = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive');
    mockClock.utcMs += 24 * 60 * 60 * 1000;
    expect((await createCheckIn(await core(), { commandId: newCommandId(), boardId, source: 'app', note: 'new day' })).ok).toBe(true);
    act(() => { confirm?.onPress?.(); });
    await settle();
    expect(await checks(boardId)).toHaveLength(0);
    expect(await listBoardCheckInsForDate((await core()).db, boardId, '2026-08-31' as LogicalDate)).toEqual([expect.objectContaining({ note: 'new day' })]);
    expect(screen.getByRole('button', { name: 'Uncheck' })).toBeOnTheScreen();
  });

  it('rejects a note edited during confirmation and releases the pending guard', async () => {
    const boardId = await seed('daily', ['original note']);
    const [original] = await checks(boardId);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    await press('daily-widget-action');
    expect((await updateCheckIn(await core(), {
      commandId: newCommandId(), checkInId: original.id, expectedMutationStamp: original.mutationStamp,
      logicalDate: original.logicalDate, note: 'edited during prompt',
    })).ok).toBe(true);
    act(() => { jest.mocked(Alert.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive')?.onPress?.(); });
    await settle();
    expect(await checks(boardId)).toEqual([expect.objectContaining({ id: original.id, note: 'edited during prompt' })]);
    expect(screen.getByTestId('daily-widget-error')).toBeOnTheScreen();
    expect(screen.getByTestId('daily-widget-action')).not.toBeDisabled();
  });

  it('does not mutate after the action screen unmounts during confirmation', async () => {
    const boardId = await seed('daily', ['retained after leaving']);
    const before = await checks(boardId);
    const rendered = renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId('daily-widget-action');
    await press('daily-widget-action');
    const confirm = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2]?.find((button) => button.style === 'destructive');
    rendered.unmount();
    act(() => { confirm?.onPress?.(); });
    await settle();
    expect(await checks(boardId)).toEqual(before);
  });

  it.each(['archived', 'deleted'])('opens a recoverable %s board state without mutation', async (status) => {
    const boardId = await seed('daily', ['retained']);
    const deps = await core();
    const command = status === 'archived' ? archiveBoard : deleteBoard;
    expect((await command(deps, { commandId: newCommandId(), boardId })).ok).toBe(true);
    const before = await checks(boardId);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}/quick-action` });
    await screen.findByTestId(status === 'archived' ? 'daily-widget-archived' : 'daily-widget-unavailable');
    expect(screen.queryByTestId('daily-widget-action')).toBeNull();
    expect(await checks(boardId)).toEqual(before);
  });
});
