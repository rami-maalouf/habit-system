import { act } from '@testing-library/react-native';
import { Alert } from 'react-native';

import * as commands from '@/core/domain/commands';
import * as checkInCommands from '@/core/domain/check-in-commands';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import * as queries from '@/core/domain/queries';
import { err, ok } from '@/core/domain/result';

import {
  getProductCore, mockClock, newCommandId, resetProductCoreForTests,
} from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light' },
}));

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seedBoard(title: string, kind: 'daily' | 'count' = 'daily') {
  const result = await commands.createBoard(await core(), {
    commandId: newCommandId(), title, kind, symbol: 'star.fill', accentHex: '#78D98B',
    usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function seedCheck(boardId: BoardId, note?: string) {
  const result = await commands.createCheckIn(await core(), {
    commandId: newCommandId(), boardId, note, source: 'app',
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.checkInId;
}

async function liveChecks(boardId: BoardId) {
  return (await core()).db.getAllAsync<{ id: CheckInId; logical_date: string; note: string | null }>(
    'SELECT id, logical_date, note FROM check_ins WHERE board_id = ? AND deleted_at IS NULL ORDER BY id',
    [boardId],
  );
}

async function openHome(lastIndex = 0) {
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId(`board-card-${lastIndex}-quick`);
  await settle();
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('daily home mutation races', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetProductCoreForTests();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it.each(['checked state', 'logical date'] as const)(
    'refreshes a stale displayed %s without applying the opposite action',
    async (changed) => {
      const boardId = await seedBoard('stale card');
      await openHome();
      if (changed === 'checked state') await seedCheck(boardId, 'other writer');
      else mockClock.utcMs += 24 * 60 * 60 * 1000;
      const before = await liveChecks(boardId);
      const toggle = jest.spyOn(checkInCommands, 'toggleDailyCheckIn');

      await press('board-card-0-quick');

      expect(toggle).not.toHaveBeenCalled();
      expect(await liveChecks(boardId)).toEqual(before);
      expect(screen.getByTestId('quick-error')).toBeOnTheScreen();
      expect(screen.queryByTestId('undo-check-in')).toBeNull();
      expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked)
        .toBe(changed === 'checked state');
    },
  );

  it('keeps the captured logical date when midnight passes during a note confirmation', async () => {
    const boardId = await seedBoard('nightly reading');
    const original = await seedCheck(boardId, 'keep the selected day explicit');
    await openHome();
    const toggle = jest.spyOn(checkInCommands, 'toggleDailyCheckIn');

    await press('board-card-0-quick');
    const alert = jest.mocked(Alert.alert).mock.calls.at(-1);
    expect(alert?.[1]).toContain('2026-08-30');
    const confirm = alert?.[2]?.find((button) => button.style === 'destructive');
    expect(confirm).toBeDefined();
    mockClock.utcMs += 24 * 60 * 60 * 1000;
    const nextDay = await seedCheck(boardId, 'the next day must survive');
    act(() => { confirm?.onPress?.(); });
    await settle();

    expect(toggle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      logicalDate: '2026-08-30',
      expectedCheckIns: [expect.objectContaining({ checkInId: original })],
    }));
    expect(await liveChecks(boardId)).toEqual([
      { id: nextDay, logical_date: '2026-08-31', note: 'the next day must survive' },
    ]);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
  });

  it('locks repeated same-board taps synchronously while another board can finish independently', async () => {
    const first = await seedBoard('waiting habit');
    const second = await seedBoard('independent habit');
    await openHome(1);
    const actualSnapshot = queries.getDailyToggleSnapshot;
    const waiting = deferred<Awaited<ReturnType<typeof actualSnapshot>>>();
    const snapshot = jest.spyOn(queries, 'getDailyToggleSnapshot').mockImplementation((deps, boardId, date) =>
      boardId === first ? waiting.promise : actualSnapshot(deps, boardId, date),
    );
    const firstButton = screen.getByTestId('board-card-0-quick');
    const secondButton = screen.getByTestId('board-card-1-quick');
    act(() => {
      fireEvent.press(firstButton);
      fireEvent.press(firstButton);
      fireEvent.press(secondButton);
    });
    await settle();

    expect(snapshot.mock.calls.filter(([, id]) => id === first)).toHaveLength(1);
    expect(await liveChecks(first)).toHaveLength(0);
    expect(await liveChecks(second)).toHaveLength(1);
    expect(screen.getByTestId('board-card-0-quick')).toBeDisabled();
    expect(screen.getByTestId('board-card-1-quick')).not.toBeDisabled();

    const fresh = await actualSnapshot(await core(), first);
    await act(async () => { waiting.resolve(fresh); await Promise.resolve(); });
    await settle();
    expect(await liveChecks(first)).toHaveLength(1);
    expect(await liveChecks(second)).toHaveLength(1);
    expect(screen.getByTestId('board-card-0-quick')).not.toBeDisabled();
  });

  it('rolls back a storage failure, shows no success target, and releases the board for retry', async () => {
    const boardId = await seedBoard('retry safely');
    await openHome();
    const db = (await core()).db;
    const failure = jest.spyOn(db, 'runAsync').mockRejectedValueOnce(new Error('simulated disk failure'));

    await press('board-card-0-quick');

    expect(await liveChecks(boardId)).toHaveLength(0);
    expect(screen.getByTestId('quick-error')).toHaveTextContent(/simulated disk failure/);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect(screen.getByTestId('board-card-0-quick')).not.toBeDisabled();
    failure.mockRestore();
    await press('board-card-0-quick');
    expect(await liveChecks(boardId)).toHaveLength(1);
    expect(screen.queryByTestId('quick-error')).toBeNull();
    expect(screen.getByTestId('undo-check-in')).toBeOnTheScreen();
  });

  it('undoes only the quick-created record even when a newer check arrives and Undo is pressed twice', async () => {
    const boardId = await seedBoard('count race', 'count');
    const older = await seedCheck(boardId, 'older retained record');
    await openHome();
    const create = jest.spyOn(checkInCommands, 'createCheckIn');
    await press('board-card-0-quick');
    const quickInput = create.mock.calls[0][1];
    const afterQuick = await liveChecks(boardId);
    const quickId = afterQuick.find((check) => check.id !== older)?.id;
    expect(quickId).toBeDefined();
    mockClock.utcMs += 1000;
    const newer = await seedCheck(boardId, 'newer concurrent record');
    const undo = jest.spyOn(checkInCommands, 'undoCreatedCheckIn');
    const undoButton = screen.getByTestId('undo-check-in');
    act(() => {
      fireEvent.press(undoButton);
      fireEvent.press(undoButton);
    });
    await settle();

    expect(undo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      checkInId: quickId, createdByCommandId: quickInput.commandId,
    }));
    expect((await liveChecks(boardId)).map((check) => check.id).sort()).toEqual([older, newer].sort());
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
  });

  it('refreshes instead of inverting a committed completion after an uncertain failure', async () => {
    const boardId = await seedBoard('uncertain result');
    await openHome();
    const staleProjection = await queries.getHomeBoardProjection(await core());
    const delayedRefresh = deferred<Awaited<ReturnType<typeof queries.getHomeBoardProjection>>>();
    jest.spyOn(queries, 'getHomeBoardProjection').mockImplementationOnce(() => delayedRefresh.promise);
    const actualToggle = checkInCommands.toggleDailyCheckIn;
    const toggle = jest.spyOn(checkInCommands, 'toggleDailyCheckIn').mockImplementationOnce(async (deps, input) => {
      const committed = await actualToggle(deps, input);
      expect(committed.ok).toBe(true);
      return err('database', 'The result could not be received.', { retryable: true });
    });

    await press('board-card-0-quick');
    const committed = await liveChecks(boardId);
    expect(committed).toHaveLength(1);
    expect(screen.getByTestId('quick-error')).toHaveTextContent(/result could not be received/);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked).toBe(false);

    await press('board-card-0-quick');

    expect(toggle).toHaveBeenCalledTimes(1);
    expect(await liveChecks(boardId)).toEqual(committed);
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked).toBe(true);
    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    await act(async () => { delayedRefresh.resolve(staleProjection); await Promise.resolve(); });
    await settle();
    expect(screen.getByTestId('board-card-0-quick').props.accessibilityState.checked).toBe(true);
  });

  it('does not offer an Undo target for a replayed no-op creation receipt', async () => {
    const boardId = await seedBoard('no-op receipt', 'count');
    const existing = await seedCheck(boardId, 'belongs to another creation');
    await openHome();
    jest.spyOn(checkInCommands, 'createCheckIn').mockResolvedValueOnce(ok({
      checkInId: existing, logicalDate: '2026-08-30' as LogicalDate, created: false,
    }));

    await press('board-card-0-quick');

    expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect(await liveChecks(boardId)).toEqual([
      { id: existing, logical_date: '2026-08-30', note: 'belongs to another creation' },
    ]);
  });
});
