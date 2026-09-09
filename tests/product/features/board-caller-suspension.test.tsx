import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, useLocalSearchParams } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Text } from 'react-native';

import * as commands from '@/core/domain/commands';
import * as checks from '@/core/domain/check-in-commands';
import type { BoardId, CommandId } from '@/core/domain/ids';
import * as queries from '@/core/domain/queries';
import { BoardsHomeScreen } from '@/features/boards/boards-home';
import { BoardDetailScreen } from '@/features/boards/board-detail';
import { CheckInHistoryScreen } from '@/features/check-in-history/history-screen';
import { HistoryList } from '@/features/check-in-history/history-list';
import { ArchivedBoardsScreen } from '@/features/settings/archived-boards-screen';
import { ProductContext, type FeatureEffects } from '@/features/product-store/context';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { ProductPressable } from '@/features/ui';
import { missAlertScheduler, reminderScheduler } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function held<Args extends unknown[], Result>(actual: (...args: Args) => Promise<Result>) {
  const entered = gate(), response = gate();
  return { entered, response, run: async (...args: Args) => { const result = await actual(...args); entered.resolve(); await response.promise; return result; } };
}
const effects: FeatureEffects = { kind: 'real', reminders: reminderScheduler, missAlerts: missAlertScheduler,
  cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
  supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(), openSystemSettings: jest.fn() };

jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(() => Promise.resolve()), ImpactFeedbackStyle: { Light: 'light' } }));

describe('board caller operation and navigation ownership', () => {
  let h: TestHarness, owner: OperationOwner, boardId: BoardId;
  let sample = false;
  beforeEach(async () => { h = await createTestHarness(); sample = false; owner = createOperationOwner(h.deps, effects); boardId = await board('Practice'); });
  afterEach(async () => { cleanup(); await owner.suspend(); jest.restoreAllMocks(); await h.db.closeAsync(); });
  async function board(title: string, kind: 'daily' | 'count' = 'count', metricsEnabled = true) {
    const result = await commands.createBoard(h.deps, { commandId: h.ids.nextCommandId(), title, kind,
      symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, startOfDayMinute: 0, metricsEnabled, earnsCoins: true, coinCapPerDay: 10 });
    if (!result.ok) throw Error(result.error.message); return result.value.boardId;
  }
  async function check(note?: string) {
    const result = await checks.createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app', note });
    if (!result.ok) throw Error(result.error.message); return result.value.checkInId;
  }
  function Context({ children }: { children: React.ReactNode }) {
    const scope = useSyncExternalStore(owner.subscribe, owner.getScope, owner.getScope);
    const [version, setVersion] = useState(0);
    return <ProductContext.Provider value={{ core: owner.core, scope, closeSample: null, version,
      invalidate: () => { if (scope.isCurrent()) setVersion(value => value + 1); }, nextCommandId: () => h.ids.uuid() as CommandId,
      sync: { status: 'idle', busy: false, error: null }, syncNow: jest.fn(), pauseSync: jest.fn(), resumeSync: jest.fn(),
      missAlertScheduler, missAlertVersion: 0 }}>{children}</ProductContext.Provider>;
  }
  function Root() { return <ThemeProvider value={DefaultTheme}>{sample ? <Stack /> : <Context><Stack /></Context>}</ThemeProvider>; }
  function Sample() { return <Context><Stack /></Context>; }
  function Detail() { return <BoardDetailScreen boardId={useLocalSearchParams<{ boardId: BoardId }>().boardId} />; }
  function History() { return <CheckInHistoryScreen boardId={useLocalSearchParams<{ boardId: BoardId }>().boardId} />; }
  async function open(path = '/') {
    const routes = { index: BoardsHomeScreen, 'boards/[boardId]/index': Detail, 'boards/[boardId]/check-ins/index': History,
      'settings/archived': ArchivedBoardsScreen, 'settings/index': () => <Text>Scoped Settings</Text>,
      'boards/new': () => <Text>Scoped board form</Text>, 'stacks/index': () => <Text>Scoped Stacks</Text>,
      'boards/[boardId]/edit': () => <Text>Scoped board edit</Text>,
      'boards/[boardId]/analytics': () => <Text>Scoped Analytics</Text>, 'boards/[boardId]/journal': () => <Text>Scoped Journal</Text>,
      'boards/[boardId]/check-ins/new': () => <Text>Scoped check form</Text>,
      'boards/[boardId]/check-ins/[checkInId]': () => <Text>Scoped check edit</Text> };
    renderRouter({ _layout: Root, ...routes, cover: () => <Text>Covered scene</Text>, 'sample/_layout': Sample,
      ...Object.fromEntries(Object.entries(routes).map(([key, value]) => [`sample/${key}`, value])),
    }, { initialUrl: path }); await settle();
  }
  function callback(id: string) { const button = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === id); if (!button) throw Error(`missing ${id}`); return button.props.onPress as () => void; }
  async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
  async function pause() { await act(async () => { await owner.suspend(); }); await settle(); }
  async function resume() { act(() => owner.resume()); await settle(); }
  async function retire(mode: 'scope' | 'cover') {
    if (mode === 'scope') { await pause(); await resume(); }
    else { act(() => router.push('/cover')); await settle(); act(() => router.back()); await settle(); }
  }
  async function joinHeld(wait: { entered: ReturnType<typeof gate>; response: ReturnType<typeof gate> }) {
    await wait.entered.promise;
    let joined = false, joining!: Promise<void>;
    act(() => { joining = owner.suspend().then(() => { joined = true; }); }); await settle();
    const early = joined;
    await act(async () => { wait.response.resolve(); await joining; }); await settle();
    expect(early).toBe(false);
  }
  async function receipts() { return h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id'); }

  it('joins an accepted home Count check and rejects old callbacks without reviving Undo after resume', async () => {
    await open(); const wait = held(checks.createCheckIn); const create = jest.spyOn(checks, 'createCheckIn').mockImplementationOnce(wait.run);
    const old = callback('board-card-0-quick'); act(() => { void old(); void old(); });
    await joinHeld(wait); expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0][0]).toBe(h.deps);
    const before = await receipts(); await resume(); act(() => { void old(); }); await settle();
    expect(await receipts()).toEqual(before); expect(screen.queryByTestId('undo-check-in')).toBeNull();
    expect((await queries.getHomeBoardProjection(h.deps))).toMatchObject({ ok: true, value: [expect.objectContaining({ strip: expect.arrayContaining([1]) })] });
  });

  it('joins a Daily fresh read but retires its unaccepted toggle continuation', async () => {
    await commands.deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); boardId = await board('Daily', 'daily');
    await open(); const wait = held(queries.getDailyToggleSnapshot); jest.spyOn(queries, 'getDailyToggleSnapshot').mockImplementationOnce(wait.run);
    const toggle = jest.spyOn(checks, 'toggleDailyCheckIn'); const before = await receipts();
    act(() => { void callback('board-card-0-quick')(); }); await joinHeld(wait);
    expect(toggle).not.toHaveBeenCalled(); expect(await receipts()).toEqual(before);
  });

  it.each(['scope', 'cover'] as const)('cancels an unanswered Home prompt on %s retirement and keeps a fresh action usable', async mode => {
    await commands.deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); boardId = await board('Daily', 'daily'); await check('Keep this note');
    const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); await open();
    await press('board-card-0-quick'); const old = alerts.mock.calls.at(-1)![2]!.find(b => b.style === 'destructive')!.onPress!;
    const before = await receipts(); await retire(mode);
    const enabled = !screen.getByTestId('board-card-0-quick').props.accessibilityState.disabled;
    act(() => old()); await settle(); expect(await receipts()).toEqual(before); expect(enabled).toBe(true);
    await press('board-card-0-quick'); act(() => alerts.mock.calls.at(-1)![2]!.find(b => b.style === 'destructive')!.onPress!()); await settle();
    expect(await h.db.getAllAsync('SELECT * FROM check_ins WHERE deleted_at IS NULL')).toEqual([]);
  });

  it('joins Home Undo and refuses a captured old Undo after return', async () => {
    await open(); await press('board-card-0-quick'); const old = callback('undo-check-in');
    const wait = held(checks.undoCreatedCheckIn); const undo = jest.spyOn(checks, 'undoCreatedCheckIn').mockImplementationOnce(wait.run);
    act(() => { void old(); }); await joinHeld(wait); const before = await receipts(); await resume(); act(() => { void old(); }); await settle();
    expect(undo).toHaveBeenCalledTimes(1); expect(undo.mock.calls[0][0]).toBe(h.deps); expect(await receipts()).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins WHERE deleted_at IS NULL')).toEqual([]);
  });

  it('joins one queued reorder, rejects duplicates and stale callbacks, and preserves actual order', async () => {
    const second = await board('Second'); await open(); await press('toggle-edit-boards');
    const old = callback('board-card-1-move-up'); const wait = held(commands.reorderBoard); const move = jest.spyOn(commands, 'reorderBoard').mockImplementationOnce(wait.run);
    act(() => { void old(); void old(); }); await joinHeld(wait); const before = await receipts(); await resume(); act(() => { void old(); }); await settle();
    expect(move).toHaveBeenCalledTimes(1); expect(move.mock.calls[0][0]).toBe(h.deps); expect(await receipts()).toEqual(before);
    expect(await h.db.getAllAsync('SELECT id FROM boards WHERE deleted_at IS NULL ORDER BY order_key,id')).toEqual([{ id: second }, { id: boardId }]);
  });

  it('joins a detail Restore and refuses its stale and removed-scene callbacks', async () => {
    await commands.archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); await open(`/boards/${boardId}`);
    const old = callback('restore-board'); const wait = held(commands.restoreBoard); const restore = jest.spyOn(commands, 'restoreBoard').mockImplementationOnce(wait.run);
    act(() => { void old(); void old(); }); await joinHeld(wait); const before = await receipts(); await resume();
    act(() => { void old(); }); await settle(); act(() => router.replace('/')); await settle(); act(() => { void old(); }); await settle();
    expect(restore).toHaveBeenCalledTimes(1); expect(restore.mock.calls[0][0]).toBe(h.deps); expect(await receipts()).toEqual(before);
  });

  it('joins Enable Metrics and does not let its retired callback write a second receipt', async () => {
    await commands.deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); boardId = await board('Metrics off', 'count', false); await open(`/boards/${boardId}`);
    const old = callback('enable-metrics'); const wait = held(commands.updateBoard); const update = jest.spyOn(commands, 'updateBoard').mockImplementationOnce(wait.run);
    act(() => { void old(); }); await joinHeld(wait); const before = await receipts(); await resume(); act(() => { void old(); }); await settle();
    expect(update).toHaveBeenCalledTimes(1); expect(update.mock.calls[0][0]).toBe(h.deps); expect(await receipts()).toEqual(before);
    expect(await queries.getBoard(h.deps, boardId)).toMatchObject({ ok: true, value: { metricsEnabled: true } });
  });

  it('joins delete preflight without joining its future human decision or showing it after retirement', async () => {
    await commands.archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); await open(`/boards/${boardId}`);
    const wait = held(queries.getBoardDependentCounts); jest.spyOn(queries, 'getBoardDependentCounts').mockImplementationOnce(wait.run);
    const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); const before = await receipts();
    act(() => { void callback('delete-board')(); }); await joinHeld(wait); expect(alerts).not.toHaveBeenCalled(); expect(await receipts()).toEqual(before);
  });

  it.each(['scope', 'cover'] as const)('retires detail Delete confirmation on %s and joins the fresh accepted delete', async mode => {
    await commands.archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId }); await open(`/boards/${boardId}`);
    const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); await press('delete-board');
    const old = alerts.mock.calls.at(-1)![2]!.find(b => b.style === 'destructive')!.onPress!;
    const before = await receipts(); await retire(mode); act(() => old()); await settle(); expect(await receipts()).toEqual(before);
    await press('delete-board'); const fresh = alerts.mock.calls.at(-1)![2]!.find(b => b.style === 'destructive')!.onPress!;
    const wait = held(commands.deleteBoard); const remove = jest.spyOn(commands, 'deleteBoard').mockImplementationOnce(wait.run);
    act(() => { fresh(); fresh(); }); await joinHeld(wait); expect(remove).toHaveBeenCalledTimes(1); expect(remove.mock.calls[0][0]).toBe(h.deps);
    expect(screen).toHavePathname(`/boards/${boardId}`); await resume(); expect(screen.getByTestId('board-recovery-home')).toBeOnTheScreen();
  });

  it('joins a native history delete, rejects duplicate and retired swipe/page callbacks', async () => {
    const id = await check(); await open(`/boards/${boardId}/check-ins`);
    const list = screen.UNSAFE_getByType(HistoryList); const oldDelete = list.props.onDelete as (id: string) => void;
    const oldMore = list.props.onLoadMore as () => void;
    const wait = held(checks.removeCheckIn); const remove = jest.spyOn(checks, 'removeCheckIn').mockImplementationOnce(wait.run);
    act(() => { oldDelete(id); oldDelete(id); }); await joinHeld(wait); const before = await receipts(); await resume();
    const read = jest.spyOn(queries, 'getGroupedCheckInHistory'); act(() => { oldDelete(id); oldMore(); }); await settle();
    expect(remove).toHaveBeenCalledTimes(1); expect(remove.mock.calls[0][0]).toBe(h.deps); expect(read).not.toHaveBeenCalled(); expect(await receipts()).toEqual(before);
    expect(screen.getByTestId('history-empty')).toBeOnTheScreen();
  });

  it('keeps Home, detail, history and archived destinations inside the actual nested sample stack', async () => {
    const id = await check(); sample = true; owner = createOperationOwner(h.deps, { kind: 'sample-disabled' }); await open('/sample');
    for (const [control, destination] of [['open-settings', '/sample/settings'], ['open-stacks', '/sample/stacks'], ['create-board', '/sample/boards/new']] as const) {
      await press(control); expect(screen).toHavePathname(destination); act(() => router.back()); await settle();
    }
    fireEvent.press(screen.getByRole('button', { name: 'Practice' })); await settle(); expect(screen).toHavePathname(`/sample/boards/${boardId}`);
    for (const [control, destination] of [['open-analytics', 'analytics'], ['open-journal', 'journal'], ['edit-board', 'edit'], ['detail-add-check-in', 'check-ins/new']] as const) {
      await press(control); expect(screen).toHavePathname(`/sample/boards/${boardId}/${destination}`); act(() => router.back()); await settle();
    }
    await press('open-check-ins'); expect(screen).toHavePathname(`/sample/boards/${boardId}/check-ins`);
    const list = screen.UNSAFE_getByType(HistoryList); act(() => list.props.onOpen(id)); await settle(); expect(screen).toHavePathname(`/sample/boards/${boardId}/check-ins/${id}`);
    act(() => router.back()); await settle(); await press('add-check-in'); expect(screen).toHavePathname(`/sample/boards/${boardId}/check-ins/new`);
    await commands.archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId });
    act(() => router.replace('/sample/settings/archived')); await settle(); const old = callback(`archived-board-${boardId}`);
    await retire('scope'); act(() => old()); await settle(); expect(screen).toHavePathname('/sample/settings/archived');
    await press(`archived-board-${boardId}`); expect(screen).toHavePathname(`/sample/boards/${boardId}`);
  });
});
