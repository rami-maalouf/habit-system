import { act } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { createBoard, createCheckIn, updateBoard, updateCheckIn } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { listBoardCheckInsForDate } from '@/core/persistence/repositories/check-ins';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

const today = '2026-08-30' as LogicalDate;
const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seed(title = 'morning walk', notes: string[] = [], kind: 'daily' | 'count' = 'daily', metricsEnabled = true) {
  const deps = await core();
  const result = await createBoard(deps, {
    commandId: newCommandId(), kind: notes.length > 1 ? 'count' : kind, title,
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: true,
    tracksAmount: false, amountUnit: null, quickAmount: 1, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled,
  });
  if (!result.ok) throw new Error(result.error.message);
  const boardId = result.value.boardId;
  for (const note of notes) {
    expect((await createCheckIn(deps, { commandId: newCommandId(), boardId, source: 'app', note })).ok).toBe(true);
  }
  if (notes.length > 1 && kind === 'daily') {
    const board = await getBoardById(deps.db, boardId);
    if (!board) throw new Error('missing seeded board');
    expect((await updateBoard(deps, { ...board, commandId: newCommandId(), boardId, expectedMutationStamp: board.mutationStamp, kind: 'daily' })).ok).toBe(true);
  }
  return boardId;
}

async function checks(boardId: BoardId, date = today) {
  return listBoardCheckInsForDate((await core()).db, boardId, date);
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

function answerConfirmation(style: 'cancel' | 'destructive') {
  const buttons = alertSpy.mock.calls.at(-1)?.[2];
  const button = buttons?.find((entry) => entry.style === style);
  if (!button?.onPress) throw new Error('missing confirmation action');
  act(() => button.onPress?.());
}

describe('Daily Home cards', () => {
  beforeEach(() => {
    resetProductCoreForTests();
    alertSpy.mockClear();
  });

  it('renders a compact row with accessible daily state, checks once, and offers precise Undo', async () => {
    const boardId = await seed();
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    expect(screen.getByRole('checkbox', { name: 'Not checked, double tap to check', checked: false })).toBeOnTheScreen();
    expect(screen.getByTestId('board-card-0')).toHaveStyle({ flexDirection: 'row' });
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityHint).toContain('0/7 this week');
    await press('board-card-0-quick');
    expect(screen.getByRole('checkbox', { name: 'Checked, double tap to uncheck', checked: true })).toBeOnTheScreen();
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityHint).toContain('1/7 this week');
    expect(await checks(boardId)).toHaveLength(1);
    await press('undo-check-in');
    expect(await checks(boardId)).toHaveLength(0);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect(screen.getByRole('checkbox', { checked: false })).toBeOnTheScreen();
  });

  it('unchecks without notes immediately and clears the creation Undo', async () => {
    const boardId = await seed();
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    await press('board-card-0-quick');
    await press('board-card-0-quick');
    expect(await checks(boardId)).toHaveLength(0);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
  });

  it('confirms all retained notes and cancellation preserves every record', async () => {
    const boardId = await seed('reading', ['first note', 'second note']);
    const before = await checks(boardId);
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityHint).toContain('1/7 this week');
    await press('board-card-0-quick');
    expect(alertSpy).toHaveBeenCalledWith('Uncheck reading?', expect.stringMatching(/2026-08-30.*2 check-ins.*2 notes/), expect.any(Array), expect.any(Object));
    answerConfirmation('cancel');
    await settle();
    expect(await checks(boardId)).toEqual(before);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect(screen.getByTestId('board-card-0-quick')).toBeEnabled();
  });

  it('rejects edits during confirmation without clearing any records', async () => {
    const boardId = await seed('reading', ['first note', 'second note']);
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    await press('board-card-0-quick');
    const [check] = await checks(boardId);
    const changed = await updateCheckIn(await core(), { commandId: newCommandId(), checkInId: check.id, expectedMutationStamp: check.mutationStamp, logicalDate: today, note: 'edited during confirmation' });
    expect(changed.ok).toBe(true);
    answerConfirmation('destructive');
    await settle();
    expect(await checks(boardId)).toHaveLength(2);
    expect(screen.getByTestId('quick-error')).toHaveTextContent(/changed/);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
  });

  it('confirms clearing every retained check-in and note without offering Undo', async () => {
    const boardId = await seed('reading', ['first note', 'second note']);
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    await press('board-card-0-quick');
    answerConfirmation('destructive');
    await settle();
    expect(await checks(boardId)).toHaveLength(0);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
  });

  it('keeps weekly completion accessible when streak metrics are disabled', async () => {
    await seed('a daily habit with a longer title that stays readable', ['complete'], 'daily', false);
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    expect(screen.getByText('a daily habit with a longer title that stays readable')).toBeOnTheScreen();
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityHint).toContain('1/7 this week');
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityHint).not.toMatch(/days? streak/);
    expect(screen.getByRole('checkbox', { checked: true })).toBeOnTheScreen();
  });

  it('preserves Count quick actions and repeated check-ins without Daily summaries', async () => {
    const boardId = await seed('water', [], 'count');
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    expect(screen.getByRole('button', { name: 'Check in to water' })).toBeOnTheScreen();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/this week/)).toBeNull();
    expect(screen.queryAllByTestId(/board-card-0-day-\d+$/)).toHaveLength(0);
    await press('board-card-0-quick');
    await press('board-card-0-quick');
    expect(await checks(boardId)).toHaveLength(2);
    await press('undo-check-in');
    expect(await checks(boardId)).toHaveLength(1);
  });
});
