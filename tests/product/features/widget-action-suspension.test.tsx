import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Text } from 'react-native';

import * as commands from '@/core/domain/commands';
import * as checkCommands from '@/core/domain/check-in-commands';
import type { BoardId, CommandId } from '@/core/domain/ids';
import * as queries from '@/core/domain/queries';
import { DailyWidgetActionScreen, WidgetCheckInEntryScreen } from '@/features/boards/daily-widget-action-screen';
import { ProductContext, type FeatureEffects } from '@/features/product-store/context';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { PrimaryButton } from '@/features/ui';
import { missAlertScheduler, reminderScheduler } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const effects: FeatureEffects = { kind: 'real', reminders: reminderScheduler, missAlerts: missAlertScheduler,
  cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
  supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(), openSystemSettings: jest.fn() };

describe('widget action scope ownership', () => {
  let harness: TestHarness, owner: OperationOwner, boardId: BoardId;
  beforeEach(async () => {
    harness = await createTestHarness();
    owner = createOperationOwner(harness.deps, effects);
    const board = await commands.createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Read', kind: 'daily',
      symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw Error(board.error.message);
    boardId = board.value.boardId;
  });
  afterEach(async () => { cleanup(); await owner.suspend(); jest.restoreAllMocks(); await harness.db.closeAsync(); });
  function Root() {
    const scope = useSyncExternalStore(owner.subscribe, owner.getScope, owner.getScope);
    const [version, setVersion] = useState(0);
    return <ThemeProvider value={DefaultTheme}><ProductContext.Provider value={{ core: owner.core, scope,
      closeSample: null, version, invalidate: () => { if (scope.isCurrent()) setVersion(value => value + 1); },
      nextCommandId: () => harness.ids.uuid() as CommandId, sync: { status: 'idle', busy: false, error: null },
      syncNow: jest.fn(), pauseSync: jest.fn(), resumeSync: jest.fn(), missAlertScheduler, missAlertVersion: 0,
    }}><Stack /></ProductContext.Provider></ThemeProvider>;
  }
  async function open(entry = false) {
    const view = renderRouter({ _layout: Root, index: () => <Text>Boards</Text>, widget: () => entry
      ? <WidgetCheckInEntryScreen boardId={boardId} /> : <DailyWidgetActionScreen boardId={boardId} />,
      'boards/[boardId]/quick-action': () => <Text>Redirected real action</Text> }, { initialUrl: '/' });
    act(() => router.push('/widget'));
    await settle();
    return view;
  }
  function callback(id: string) {
    const button = screen.UNSAFE_getAllByType(PrimaryButton).find(item => item.props.testID === id);
    if (!button) throw Error(`missing ${id}`);
    return button.props.onPress as () => void;
  }
  async function pause() { await act(async () => { await owner.suspend(); }); await settle(); }
  async function resume() { act(() => owner.resume()); await settle(); }

  it.each([false, true])('disables the sample widget entry before any read (count entry: %s)', async entry => {
    owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const read = jest.spyOn(harness.db, 'getFirstAsync');
    await open(entry);
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText('Widget actions are disabled in sample mode.')).toBeOnTheScreen();
    expect(screen.queryByTestId('daily-widget-action')).toBeNull();
  });

  it('joins a fresh snapshot read and refuses its retired continuation and old callback', async () => {
    await open();
    const actual = queries.getDailyToggleSnapshot, held = deferred();
    const read = jest.spyOn(queries, 'getDailyToggleSnapshot').mockImplementationOnce(async (...args) => {
      await held.promise; return actual(...args);
    });
    const toggle = jest.spyOn(checkCommands, 'toggleDailyCheckIn');
    const oldAction = callback('daily-widget-action');
    act(oldAction); await settle();
    let joined = false, joining!: Promise<void>;
    act(() => { joining = owner.suspend().then(() => { joined = true; }); }); await settle();
    const early = joined;
    await act(async () => { held.resolve(); await joining; }); await settle();
    expect(early).toBe(false);
    expect(await read.mock.results[0].value).toMatchObject({ ok: true });
    expect(toggle).not.toHaveBeenCalled();
    await resume();
    const ids = jest.spyOn(harness.deps.ids, 'uuid');
    act(oldAction); await settle();
    expect(ids).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('daily-widget-action')); await settle();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('joins an accepted public toggle through its committed response without a retired Undo timer', async () => {
    await open();
    const actual = checkCommands.toggleDailyCheckIn, held = deferred();
    let result!: Awaited<ReturnType<typeof actual>>;
    const toggle = jest.spyOn(checkCommands, 'toggleDailyCheckIn').mockImplementationOnce(async (...args) => {
      result = await actual(...args); await held.promise; return result;
    });
    fireEvent.press(screen.getByTestId('daily-widget-action')); await settle();
    expect(result).toMatchObject({ ok: true, value: { checked: true } });
    let joined = false, joining!: Promise<void>;
    act(() => { joining = owner.suspend().then(() => { joined = true; }); }); await settle();
    const early = joined;
    await act(async () => { held.resolve(); await joining; }); await settle();
    expect(early).toBe(false);
    expect(toggle.mock.calls[0][0]).toBe(harness.deps);
    expect(await harness.db.getAllAsync('SELECT * FROM check_ins')).toHaveLength(1);
    expect(screen.queryByTestId('daily-widget-undo')).toBeNull();
    await resume();
    expect(screen.getByText('Checked')).toBeOnTheScreen();
  });

  it('does not join an unanswered uncheck prompt or accept its answer after retirement', async () => {
    await commands.createCheckIn(harness.deps, { commandId: harness.ids.nextCommandId(), boardId, note: 'Keep this note', source: 'app' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await open();
    const toggle = jest.spyOn(checkCommands, 'toggleDailyCheckIn');
    fireEvent.press(screen.getByTestId('daily-widget-action')); await settle();
    const confirm = alert.mock.calls.at(-1)?.[2]?.find(button => button.style === 'destructive')?.onPress;
    expect(confirm).toBeDefined();
    await pause(); await resume();
    try { expect(screen.getByTestId('daily-widget-action')).not.toBeDisabled(); }
    finally { await act(async () => { confirm!(); }); await settle(); }
    expect(toggle).not.toHaveBeenCalled();
    expect(await harness.db.getAllAsync('SELECT * FROM check_ins WHERE deleted_at IS NULL')).toHaveLength(1);
  });

  it('joins an accepted Undo and refuses its captured callback after resume', async () => {
    await open();
    fireEvent.press(screen.getByTestId('daily-widget-action')); await settle();
    const oldUndo = callback('daily-widget-undo');
    const actual = checkCommands.undoCreatedCheckIn, held = deferred();
    const undo = jest.spyOn(checkCommands, 'undoCreatedCheckIn').mockImplementationOnce(async (...args) => {
      await held.promise; return actual(...args);
    });
    act(() => { void oldUndo(); }); await settle();
    let joined = false, joining!: Promise<void>;
    act(() => { joining = owner.suspend().then(() => { joined = true; }); }); await settle();
    const early = joined;
    await act(async () => { held.resolve(); await joining; }); await settle();
    expect(early).toBe(false);
    expect(undo.mock.calls[0][0]).toBe(harness.deps);
    expect(await undo.mock.results[0].value).toMatchObject({ ok: true });
    const rows = await harness.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    await resume(); act(() => { void oldUndo(); }); await settle();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(await harness.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(rows);
    expect(await harness.db.getAllAsync('SELECT * FROM check_ins WHERE deleted_at IS NULL')).toHaveLength(0);
  });

  it('does not dispatch a retained callback after its scene unmounts', async () => {
    await open();
    const oldAction = callback('daily-widget-action');
    act(() => router.back()); await settle();
    const ids = jest.spyOn(harness.deps.ids, 'uuid');
    act(oldAction); await settle();
    expect(ids).not.toHaveBeenCalled();
  });
});
