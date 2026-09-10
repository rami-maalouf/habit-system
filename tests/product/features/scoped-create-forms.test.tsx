import { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { act, cleanup, within } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, type Href } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Keyboard, Text, TextInput, Switch } from 'react-native';

import * as commands from '@/core/domain/commands';
import * as checkCommands from '@/core/domain/check-in-commands';
import * as queries from '@/core/domain/queries';
import { createReminder } from '@/core/domain/reminder-commands';
import { ProductPressable } from '@/features/ui';
import * as boardCreation from '@/core/domain/create-board-with-reminders';
import type { CommandId } from '@/core/domain/ids';
import { BoardFormScreen } from '@/features/board-configuration/board-form-screen';
import { CheckInFormScreen } from '@/features/check-in-history/check-in-form-screen';
import { BoardIconPicker } from '@/features/board-configuration/board-icon-picker';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import { ProductContext, type FeatureEffects } from '@/features/product-store/context';
import { createOperationOwner } from '@/features/product-store/operation-scope';
import { missAlertScheduler, reminderScheduler, notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness } from '../helpers/test-db';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const effects: FeatureEffects = {
  kind: 'real', reminders: reminderScheduler, missAlerts: missAlertScheduler,
  cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
  supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(), openSystemSettings: jest.fn(), openReleaseLink: jest.fn(),
};

async function setup(kind: 'board' | 'check', mode: 'real' | 'sample' = 'real', edit = false, dirty = true, withReminder = false) {
  const h = await createTestHarness();
  const created = await commands.createBoard(h.deps, {
    commandId: h.ids.uuid() as CommandId, title: 'Existing count', kind: 'count',
    tracksTime: false, tracksAmount: false, symbol: 'book.fill', accentHex: '#4477AA',
    usesTintedBackground: false, metricsEnabled: true, startOfDayMinute: 0,
  });
  if (!created.ok) throw Error(created.error.message);
  const seeded = edit && kind === 'check' ? await commands.createCheckIn(h.deps, {
    commandId: h.ids.uuid() as CommandId, boardId: created.value.boardId, source: 'app', note: 'Original note',
  }) : null;
  if (seeded && !seeded.ok) throw Error(seeded.error.message);
  const reminder = withReminder ? await createReminder({ ...h.deps, scheduler: reminderScheduler }, {
    commandId: h.ids.uuid() as CommandId, boardId: created.value.boardId,
    weekdaysMask: 1, minuteOfDay: 540, enabled: false,
  }) : null;
  if (reminder && !reminder.ok) throw Error(reminder.error.message);
  const owner = createOperationOwner(h.deps, mode === 'real' ? effects : { kind: 'sample-disabled' });
  const session = new SampleSession(async () => { throw Error('This test has already supplied its core.'); });
  function Layout() {
    const scope = useSyncExternalStore(owner.subscribe, owner.getScope, owner.getScope);
    const [version, setVersion] = useState(0);
    return <ThemeProvider value={DefaultTheme}><SampleSessionProvider sessionOverride={session}><ProductContext.Provider value={{
      core: owner.core, scope, closeSample: null, version,
      invalidate: () => { if (scope.isCurrent()) setVersion(value => value + 1); },
      nextCommandId: () => h.ids.uuid() as CommandId,
      sync: { status: 'idle', busy: false, error: null },
      syncNow: jest.fn(), pauseSync: jest.fn(), resumeSync: jest.fn(),
      missAlertScheduler, missAlertVersion: 0,
    }}><Stack /></ProductContext.Provider></SampleSessionProvider></ThemeProvider>;
  }
  renderRouter({ _layout: Layout, index: () => <Text>Original destination</Text>,
    other: () => <Text>Other scene</Text>,
    form: () => kind === 'board' ? <BoardFormScreen boardId={edit ? created.value.boardId : null} />
      : <CheckInFormScreen boardId={created.value.boardId} checkInId={seeded?.ok ? seeded.value.checkInId : null} />,
  }, { initialUrl: '/' });
  act(() => router.push('/form' as Href)); await settle();
  const saveId = kind === 'board' ? 'board-form-save' : 'check-in-save';
  await screen.findByTestId(saveId);
  if (dirty && kind === 'board') fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Created once');
  else if (dirty) fireEvent.changeText(await screen.findByTestId('check-in-note'), 'Created once');
  return { h, owner, session, saveId, boardId: created.value.boardId, reminderId: reminder?.ok ? reminder.value.reminderId : null };
}

beforeEach(() => notificationsPlatformMock.reset());
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

describe.each(['board', 'check'] as const)('%s form accepted create ownership', kind => {
  it.each(kind === 'check' ? ['Done', 'native Back', 'native sheet close'] : ['Done', 'native Back'])('joins a held committed response and retains completed state for %s without stale navigation or another create', async exit => {
    const { h, owner, saveId } = await setup(kind);
    const entered = gate(), response = gate();
    const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const spy = kind === 'board'
      ? jest.spyOn(boardCreation, 'createBoardWithReminders').mockImplementation(async (...args) => {
        const result = await actualBoardCreate(...args); entered.resolve(); await response.promise; return result;
      })
      : jest.spyOn(checkCommands, 'createCheckIn').mockImplementation(async (...args) => {
        const result = await actualCheckCreate(...args); entered.resolve(); await response.promise; return result;
      });
    const oldSave = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === saveId)!.props.onPress as () => Promise<void>;
    let join: Promise<void> | undefined;
    let saved: Promise<void> | undefined;
    try {
      act(() => { saved = oldSave(); void oldSave(); });
      await entered.promise;
      let joined = false;
      act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); });
      await settle();
      expect(joined).toBe(false);
      expect(await h.db.getFirstAsync('SELECT COUNT(*) AS n FROM boards')).toEqual({ n: kind === 'board' ? 2 : 1 });
      expect(await h.db.getFirstAsync('SELECT COUNT(*) AS n FROM check_ins')).toEqual({ n: kind === 'check' ? 1 : 0 });
      await act(async () => { response.resolve(); await join; }); await settle();
      expect(screen).toHavePathname('/form');
      const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
      act(() => owner.resume()); await settle();
      expect(await screen.findByText('Done')).toBeOnTheScreen();
      act(() => { void oldSave(); }); await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
      if (exit === 'Done') fireEvent.press(screen.getByText('Done'));
      else if (exit === 'native sheet close') act(() => screen.UNSAFE_getByType(BottomSheet).props.onClose());
      else act(() => router.back());
      await settle();
      expect(alerts).not.toHaveBeenCalled();
      expect(screen).toHavePathname('/');
      expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
    } finally { await act(async () => { response.resolve(); await saved; await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
  });

  it('retries an uncertain committed result with the exact captured request and one durable create', async () => {
    const { h, saveId } = await setup(kind);
    const spy = kind === 'board'
      ? jest.spyOn(boardCreation, 'createBoardWithReminders').mockImplementationOnce(async (...args) => {
        await actualBoardCreate(...args); throw Error('private lost response');
      })
      : jest.spyOn(checkCommands, 'createCheckIn').mockImplementationOnce(async (...args) => {
        await actualCheckCreate(...args); throw Error('private lost response');
      });
    const edit = screen.UNSAFE_getAllByType(TextInput).find(node => node.props.testID ===
      (kind === 'board' ? 'board-title-input' : 'check-in-note'))!.props.onChangeText;
    try {
      fireEvent.press(screen.getByTestId(saveId)); await settle();
      expect(await screen.findByText('Retry')).toBeOnTheScreen();
      expect(screen.queryByText(/private lost response/)).toBeNull();
      const input = spy.mock.calls[0][1];
      const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
      act(() => edit('A stale changed value'));
      fireEvent.press(screen.getByText('Retry')); await settle();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][1]).toEqual(input);
      expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
      expect(await h.db.getFirstAsync('SELECT COUNT(*) AS n FROM boards')).toEqual({ n: kind === 'board' ? 2 : 1 });
      expect(await h.db.getFirstAsync('SELECT COUNT(*) AS n FROM check_ins')).toEqual({ n: kind === 'check' ? 1 : 0 });
      expect(screen).toHavePathname('/');
    } finally { cleanup(); await h.db.closeAsync(); }
  });

  it.each(['pause', 'cover'] as const)('ignores an old dirty Discard after %s and return, then accepts a fresh decision', async movement => {
    const { h, owner } = await setup(kind);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      act(() => router.back()); await settle();
      const oldDiscard = alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Discard')!.onPress!;
      if (movement === 'pause') await act(async () => { await owner.suspend(); });
      else { act(() => router.push('/other' as Href)); await settle(); }
      act(() => { if (movement === 'pause') owner.resume(); else router.back(); }); await settle();
      act(() => oldDiscard()); await settle();
      expect(screen).toHavePathname('/form');
      act(() => router.back()); await settle();
      const freshDiscard = alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Discard')!.onPress!;
      act(() => freshDiscard()); await settle();
      expect(screen).toHavePathname('/');
    } finally { cleanup(); await h.db.closeAsync(); }
  });

  it('rejects a retained Save after suspension before it can allocate or write', async () => {
    const { h, owner, saveId } = await setup(kind);
    const oldSave = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === saveId)!.props.onPress as () => Promise<void>;
    try {
      const before = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
      const allocate = jest.spyOn(h.ids, 'uuid');
      await act(async () => { await owner.suspend(); });
      await act(async () => { await oldSave(); });
      expect(allocate).not.toHaveBeenCalled();
      expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(before);
      expect(screen).toHavePathname('/form');
    } finally { cleanup(); await h.db.closeAsync(); }
  });
});

const actualBoardCreate = boardCreation.createBoardWithReminders;
const actualCheckCreate = checkCommands.createCheckIn;
const actualCheckUpdate = checkCommands.updateCheckIn;

it.each(['lost response', 'success'] as const)('retains a committed check update across a resumed query after %s', async outcome => {
  const { h, owner, saveId } = await setup('check', 'real', true);
  const entered = gate(), response = gate();
  const update = jest.spyOn(checkCommands, 'updateCheckIn').mockImplementationOnce(async (...args) => {
    const result = await actualCheckUpdate(...args);
    expect(result.ok).toBe(true);
    entered.resolve(); await response.promise;
    if (outcome === 'lost response') throw Error('private held update response');
    return result;
  });
  const save = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === saveId)!.props.onPress as () => Promise<void>;
  let saved: Promise<void> | undefined, join: Promise<void> | undefined;
  try {
    act(() => { saved = save(); }); await entered.promise;
    const input = update.mock.calls[0][1];
    const rows = await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id');
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    expect(rows).toEqual([expect.objectContaining({ note: 'Created once' })]);
    act(() => { join = owner.suspend(); });
    await act(async () => { response.resolve(); await saved; await join; });
    expect(screen).toHavePathname('/form');
    act(() => owner.resume()); await settle();
    expect(screen.queryByTestId('check-in-save')).toBeNull();
    expect(await screen.findByText(outcome === 'lost response' ? 'Retry' : 'Done')).toBeOnTheScreen();
    expect(screen.queryByText(/private held update response/)).toBeNull();
    if (outcome === 'lost response') {
      fireEvent.press(screen.getByText('Retry')); await settle();
      expect(update).toHaveBeenCalledTimes(2);
      expect(update.mock.calls[1][1]).toEqual(input);
    } else fireEvent.press(screen.getByText('Done'));
    await settle();
    expect(screen).toHavePathname('/');
    expect(await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id')).toEqual(rows);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
  } finally {
    await act(async () => { response.resolve(); await saved; await join; });
    await settle(); cleanup(); await h.db.closeAsync();
  }
});

it('creates a sample board through the ordinary command without any reminder adapter dispatch', async () => {
  const { h, saveId } = await setup('board', 'sample');
  const bundled = jest.spyOn(boardCreation, 'createBoardWithReminders');
  const authorization = jest.spyOn(reminderScheduler, 'authorization');
  const schedule = jest.spyOn(reminderScheduler, 'schedule');
  try {
    fireEvent.press(screen.getByTestId(saveId)); await settle();
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS n FROM boards')).toEqual({ n: 2 });
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
    expect(bundled).not.toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  } finally { cleanup(); await h.db.closeAsync(); }
});

it.each(['lost response', 'success'] as const)('check result survives a failed resumed board query after %s', async outcome => {
  const { h, owner, saveId } = await setup('check');
  const entered = gate(), response = gate();
  const create = jest.spyOn(checkCommands, 'createCheckIn').mockImplementationOnce(async (...args) => {
    const result = await actualCheckCreate(...args);
    expect(result.ok).toBe(true); entered.resolve(); await response.promise;
    if (outcome === 'lost response') throw Error('lost committed response');
    return result;
  });
  const save = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === saveId)!.props.onPress;
  let saved: Promise<void> | undefined, joined: Promise<void> | undefined;
  try {
    act(() => { saved = save(); }); await entered.promise;
    act(() => { joined = owner.suspend(); });
    await act(async () => { response.resolve(); await saved; await joined; });
    const input = structuredClone(create.mock.calls[0][1]);
    const before = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    const actualRead = h.db.getFirstAsync.bind(h.db);
    const read = jest.spyOn(h.db, 'getFirstAsync').mockImplementation((sql, params) =>
      sql.includes('FROM boards') ? actualRead('SELECT * FROM missing_review_table') : actualRead(sql, params));
    act(() => owner.resume()); await settle();
    read.mockRestore();
    expect(screen.getByText(outcome === 'lost response' ? 'Retry' : 'Done')).toBeOnTheScreen();
    fireEvent.press(screen.getByText(outcome === 'lost response' ? 'Retry' : 'Done')); await settle();
    if (outcome === 'lost response') expect(create.mock.calls[1][1]).toEqual(input);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(before);
    expect(screen).toHavePathname('/');
  } finally { await act(async () => { response.resolve(); await saved; await joined; }); cleanup(); await h.db.closeAsync(); }
});

it('board committed update retry survives external archive before resumed query', async () => {
  const { h, owner, saveId, boardId } = await setup('board', 'real', true);
  const actualUpdate = commands.updateBoard;
  const update = jest.spyOn(commands, 'updateBoard').mockImplementationOnce(async (...args) => {
    const result = await actualUpdate(...args); expect(result.ok).toBe(true); throw Error('lost update response');
  });
  try {
    fireEvent.press(screen.getByTestId(saveId)); await settle();
    expect(screen.getByText('Retry')).toBeOnTheScreen();
    const input = structuredClone(update.mock.calls[0][1]);
    expect((await commands.archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).ok).toBe(true);
    const before = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    await act(async () => { await owner.suspend(); });
    act(() => owner.resume()); await settle();
    expect(screen.getByText('Retry')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Retry')); await settle();
    expect(update.mock.calls[1][1]).toEqual(input);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(before);
    expect(screen).toHavePathname('/');
  } finally { cleanup(); await h.db.closeAsync(); }
});


it.each(['board', 'check'] as const)('pending untouched %s cannot be removed with native Back', async kind => {
  const { h, saveId } = await setup(kind, 'real', kind === 'board', false);
  const entered = gate(), response = gate();
  const actualUpdate = commands.updateBoard;
  const create = kind === 'board' ? jest.spyOn(commands, 'updateBoard').mockImplementationOnce(async (...args) => {
    const result = await actualUpdate(...args); expect(result.ok).toBe(true);
    entered.resolve(); await response.promise; throw Error('lost committed response');
  }) : jest.spyOn(checkCommands, 'createCheckIn').mockImplementationOnce(async (...args) => {
    const result = await actualCheckCreate(...args); expect(result.ok).toBe(true);
    entered.resolve(); await response.promise; throw Error('lost committed response');
  });
  const save = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === saveId)!.props.onPress;
  let saved: Promise<void> | undefined;
  try {
    act(() => { saved = save(); }); await entered.promise;
    const before = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/form');
    await act(async () => { response.resolve(); await saved; }); await settle();
    expect(screen.getByText('Retry')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Retry')); await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(before);
    expect(screen).toHavePathname('/');
  } finally { await act(async () => { response.resolve(); await saved; }); cleanup(); await h.db.closeAsync(); }
});

const destructiveActions = [
  { kind: 'board', command: 'archiveBoard', button: 'archive-board', confirmation: 'Archive' },
  { kind: 'board', command: 'deleteBoard', button: 'form-delete-board', confirmation: 'Delete Board' },
  { kind: 'check', command: 'removeCheckIn', button: 'delete-check-in', confirmation: 'Delete Check-In' },
] as const;

it.each(destructiveActions)('retains the exact $command receipt through a committed lost response and resume', async action => {
  const { h, owner } = await setup(action.kind, 'real', true, false);
  const entered = gate(), response = gate();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const actualCommand = action.command === 'archiveBoard' ? commands.archiveBoard
    : action.command === 'deleteBoard' ? commands.deleteBoard : commands.removeCheckIn;
  const held = async (...args: unknown[]) => {
    // each row below pairs one actual public command with its captured arguments.
    const result = await (actualCommand as (...input: unknown[]) => Promise<{ ok: boolean }>)(...args);
    expect(result.ok).toBe(true); entered.resolve(); await response.promise;
    throw Error('private destructive response');
  };
  const call = action.command === 'removeCheckIn'
    ? jest.spyOn(checkCommands, 'removeCheckIn').mockImplementationOnce(held)
    : jest.spyOn(commands, action.command).mockImplementationOnce(held);
  let join: Promise<void> | undefined;
  try {
    fireEvent.press(screen.getByTestId(action.button)); await settle();
    act(() => alert.mock.calls.at(-1)![2]!.find(button => button.text === action.confirmation)!.onPress!());
    await entered.promise;
    const input = structuredClone(call.mock.calls[0][1]);
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    const boards = await h.db.getAllAsync('SELECT * FROM boards ORDER BY id');
    const checks = await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id');
    let joined = false;
    act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); }); await settle();
    expect(joined).toBe(false);
    await act(async () => { response.resolve(); await join; }); await settle();
    act(() => owner.resume()); await settle();
    expect(screen.getByText('Retry')).toBeOnTheScreen();
    expect(screen.queryByText(/private destructive response/)).toBeNull();
    fireEvent.press(screen.getByText('Retry')); await settle();
    expect(call.mock.calls[1][1]).toEqual(input);
    expect(screen).toHavePathname('/');
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
    expect(await h.db.getAllAsync('SELECT * FROM boards ORDER BY id')).toEqual(boards);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins ORDER BY id')).toEqual(checks);
  } finally { await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
});

it.each(destructiveActions.flatMap(action => (['pause', 'cover'] as const).map(movement => ({ ...action, movement }))))('rejects a retained $command confirmation before IDs or SQL after $movement and return', async action => {
  const { h, owner } = await setup(action.kind, 'real', true, false);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    fireEvent.press(screen.getByTestId(action.button)); await settle();
    const confirm = alert.mock.calls.at(-1)![2]!.find(button => button.text === action.confirmation)!.onPress!;
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    const ids = jest.spyOn(h.ids, 'uuid');
    if (action.movement === 'pause') await act(async () => { await owner.suspend(); });
    else { act(() => router.push('/other' as Href)); await settle(); }
    act(() => { if (action.movement === 'pause') owner.resume(); else router.back(); }); await settle();
    act(() => confirm()); await settle();
    expect(ids).not.toHaveBeenCalled();
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
    expect(screen).toHavePathname('/form');
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('joins a board-delete count preflight but never opens its old alert after pause', async () => {
  const { h, owner } = await setup('board', 'real', true);
  const entered = gate(), response = gate();
  const actual = queries.getBoardDependentCounts;
  jest.spyOn(queries, 'getBoardDependentCounts').mockImplementationOnce(async (...args) => {
    const result = await actual(...args); entered.resolve(); await response.promise; return result;
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let join: Promise<void> | undefined;
  try {
    fireEvent.press(screen.getByTestId('form-delete-board')); await entered.promise;
    let joined = false;
    act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); }); await settle();
    expect(joined).toBe(false);
    await act(async () => { response.resolve(); await join; }); await settle();
    expect(alert).not.toHaveBeenCalled();
  } finally { await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
});

it('joins an existing reminder toggle permission await and rejects its old callback after resume', async () => {
  const { h, owner, reminderId } = await setup('board', 'real', true, false, true);
  const entered = gate(), response = gate();
  jest.spyOn(reminderScheduler, 'authorization').mockImplementationOnce(async () => {
    entered.resolve(); await response.promise; return 'granted';
  });
  const toggleId = `reminder-toggle-${reminderId}`;
  const toggle = screen.UNSAFE_getAllByType(Switch).find(node => node.props.testID === toggleId)!.props.onValueChange!;
  let join: Promise<void> | undefined;
  try {
    act(() => toggle(true)); await entered.promise;
    let joined = false;
    act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); }); await settle();
    expect(joined).toBe(false);
    await act(async () => { response.resolve(); await join; }); await settle();
    expect(await h.db.getFirstAsync('SELECT enabled FROM reminders WHERE id = ?', [reminderId])).toEqual({ enabled: 1 });
    act(() => owner.resume()); await settle();
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    act(() => toggle(false)); await settle();
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
    fireEvent(screen.getByTestId(toggleId), 'valueChange', false); await settle();
    expect(await h.db.getFirstAsync('SELECT enabled FROM reminders WHERE id = ?', [reminderId])).toEqual({ enabled: 0 });
  } finally { await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
});

it('shows the sample reminder explanation without mounting existing reminder controls', async () => {
  const { h } = await setup('board', 'sample', true, false, true);
  try {
    expect(screen.getByText('Reminders are unavailable in Sample mode.')).toBeOnTheScreen();
    expect(screen.queryByTestId('add-reminder-row')).toBeNull();
    expect(screen.queryAllByTestId(/^reminder-toggle-/)).toEqual([]);
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('ignores retained board picker and color callbacks after same-scope cover and return', async () => {
  const { h } = await setup('board');
  const keyboard = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  try {
    const oldOpen = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === 'open-symbol-picker')!.props.onPress!;
    const oldColor = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === 'custom-color')!.props.onPress!;
    const oldPicker = screen.UNSAFE_getByType(BoardIconPicker).props;
    act(() => router.push('/other' as Href)); await settle();
    act(() => router.back()); await settle();
    act(() => { oldOpen(); oldColor(); }); await settle();
    expect(keyboard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('custom-color-input')).toBeNull();
    expect(screen.UNSAFE_getByType(BoardIconPicker).props.isPresented).toBe(false);
    fireEvent.press(screen.getByTestId('open-symbol-picker')); await settle();
    expect(screen.UNSAFE_getByType(BoardIconPicker).props.isPresented).toBe(true);
    act(() => { oldPicker.onSelect('heart.fill'); oldPicker.onDismiss(); }); await settle();
    expect(screen.UNSAFE_getByType(BoardIconPicker).props.isPresented).toBe(true);
    expect(screen.UNSAFE_getByType(BoardIconPicker).props.symbol).not.toBe('heart.fill');
    fireEvent.press(screen.getByTestId('close-symbol-picker')); await settle();
    expect(screen.UNSAFE_getByType(BoardIconPicker).props.isPresented).toBe(false);
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('does not let an old Keep editing alert reopen the native check sheet after refocus', async () => {
  const { h } = await setup('check');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const sheet = screen.UNSAFE_getByType(BottomSheet);
    act(() => sheet.props.onClose());
    const keep = alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Keep editing')!.onPress!;
    act(() => router.push('/other' as Href)); await settle();
    act(() => router.back()); await settle();
    const present = jest.spyOn(screen.UNSAFE_getByType(BottomSheet).props.ref.current, 'present');
    act(() => keep());
    expect(present).not.toHaveBeenCalled();
    act(() => screen.UNSAFE_getByType(BottomSheet).props.onClose());
    act(() => alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Keep editing')!.onPress!());
    expect(present).toHaveBeenCalledTimes(1);
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('keeps the Sample notice and Close control inside the native check sheet', async () => {
  const { h, session } = await setup('check', 'sample');
  const close = jest.spyOn(session, 'close');
  try {
    const sheet = within(screen.getByTestId('bottom-sheet'));
    expect(sheet.getByText('Sample data. Nothing here is saved.')).toBeOnTheScreen();
    fireEvent.press(sheet.getByTestId('sample-close')); await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
  } finally { cleanup(); await h.db.closeAsync(); }
});
