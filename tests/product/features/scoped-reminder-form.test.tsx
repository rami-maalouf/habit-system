import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, type Href } from 'expo-router';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Text } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import * as commands from '@/core/domain/reminder-commands';
import type { CommandId } from '@/core/domain/ids';
import { draftStoreFor, newBoardDraft } from '@/features/board-configuration/draft-store';
import { ProductContext, type FeatureEffects } from '@/features/product-store/context';
import { createOperationOwner } from '@/features/product-store/operation-scope';
import { ReminderFormScreen } from '@/features/reminders/reminder-form-screen';
import { ProductPressable } from '@/features/ui';
import { missAlertScheduler, reminderScheduler, notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness } from '../helpers/test-db';

const effects: FeatureEffects = {
  kind: 'real', reminders: reminderScheduler, missAlerts: missAlertScheduler,
  cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
  supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(), openSystemSettings: jest.fn(), openReleaseLink: jest.fn(),
};
const actual = { create: commands.createReminder, update: commands.updateReminder, delete: commands.deleteReminder };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(mode: 'create' | 'update' | 'delete' | 'draft', sample = false, dirty = true) {
  const h = await createTestHarness();
  const board = await createBoard(h.deps, {
    commandId: h.ids.uuid() as CommandId, title: 'Reminder owner', kind: 'count',
    tracksTime: false, tracksAmount: false, symbol: 'book.fill', accentHex: '#4477AA',
    usesTintedBackground: false, metricsEnabled: true, startOfDayMinute: 0,
  });
  if (!board.ok) throw Error(board.error.message);
  const seeded = mode === 'update' || mode === 'delete' ? await actual.create({ ...h.deps, scheduler: reminderScheduler }, {
    commandId: h.ids.uuid() as CommandId, boardId: board.value.boardId,
    weekdaysMask: 1, minuteOfDay: 540, enabled: true, message: 'Original',
  }) : null;
  if (seeded && !seeded.ok) throw Error(seeded.error.message);
  const owner = createOperationOwner(h.deps, sample ? { kind: 'sample-disabled' } : effects);
  const store = draftStoreFor(owner.core);
  store.begin('test-draft'); store.start(newBoardDraft(), 'test-draft');
  function Layout() {
    const scope = useSyncExternalStore(owner.subscribe, owner.getScope, owner.getScope);
    const [version, setVersion] = useState(0);
    return <ThemeProvider value={DefaultTheme}><ProductContext.Provider value={{
      core: owner.core, scope, closeSample: null, version,
      invalidate: () => { if (scope.isCurrent()) setVersion(value => value + 1); },
      nextCommandId: () => h.ids.uuid() as CommandId,
      sync: { status: 'idle', busy: false, error: null }, syncNow: jest.fn(), pauseSync: jest.fn(), resumeSync: jest.fn(),
      missAlertScheduler, missAlertVersion: 0,
    }}><Stack /></ProductContext.Provider></ThemeProvider>;
  }
  const read = jest.spyOn(h.db, 'getFirstAsync');
  const auth = jest.spyOn(reminderScheduler, 'authorization');
  renderRouter({ _layout: Layout, index: () => <Text>Original destination</Text>,
    other: () => <Text>Other scene</Text>,
    form: () => <ReminderFormScreen boardId={mode === 'draft' ? null : board.value.boardId}
      reminderId={seeded?.ok ? seeded.value.reminderId : null} draftIndex={null} />,
  }, { initialUrl: '/' });
  act(() => router.push('/form' as Href)); await settle();
  if (!sample) {
    await screen.findByTestId('reminder-save');
    if (dirty) fireEvent.changeText(screen.getByTestId('reminder-message'), 'Captured reminder');
  }
  return { h, owner, store, read, auth };
}
beforeEach(() => notificationsPlatformMock.reset());
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

it.each(['create', 'update', 'delete'] as const)('joins and replays the exact %s receipt after a committed lost response across pause', async mode => {
  const { h, owner } = await setup(mode);
  const entered = gate(), response = gate();
  const spy = mode === 'create' ? jest.spyOn(commands, 'createReminder').mockImplementationOnce(async (...args) => {
    const result = await actual.create(...args); expect(result.ok).toBe(true); entered.resolve(); await response.promise; throw Error('private lost reminder response');
  }) : mode === 'update' ? jest.spyOn(commands, 'updateReminder').mockImplementationOnce(async (...args) => {
    const result = await actual.update(...args); expect(result.ok).toBe(true); entered.resolve(); await response.promise; throw Error('private lost reminder response');
  }) : jest.spyOn(commands, 'deleteReminder').mockImplementationOnce(async (...args) => {
    const result = await actual.delete(...args); expect(result.ok).toBe(true); entered.resolve(); await response.promise; throw Error('private lost reminder response');
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let join: Promise<void> | undefined;
  try {
    if (mode === 'delete') {
      fireEvent.press(screen.getByTestId('delete-reminder'));
      act(() => alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Delete Reminder')!.onPress!());
    } else fireEvent.press(screen.getByTestId('reminder-save'));
    await entered.promise;
    const input = spy.mock.calls[0][1];
    const rows = await h.db.getAllAsync('SELECT * FROM reminders ORDER BY id');
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    let joined = false;
    act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); }); await settle();
    expect(joined).toBe(false);
    await act(async () => { response.resolve(); await join; }); await settle();
    expect(screen).toHavePathname('/form');
    act(() => owner.resume()); await settle();
    expect(await screen.findByText('Retry')).toBeOnTheScreen();
    expect(screen.queryByText(/private lost reminder response/)).toBeNull();
    fireEvent.press(screen.getByText('Retry')); await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][1]).toEqual(input);
    expect(screen).toHavePathname('/');
    expect(await h.db.getAllAsync('SELECT * FROM reminders ORDER BY id')).toEqual(rows);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
  } finally {
    await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync();
  }
});

it('rejects a retained draft Save after pause, then accepts a fresh scoped Save on resume', async () => {
  const { h, owner, store } = await setup('draft');
  const save = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === 'reminder-save')!.props.onPress;
  try {
    await act(async () => { await owner.suspend(); });
    act(() => save()); await settle();
    expect(store.getSnapshot().draft.reminders).toEqual([]);
    expect(screen).toHavePathname('/form');
    act(() => owner.resume()); await settle();
    fireEvent.press(screen.getByTestId('reminder-save')); await settle();
    expect(store.getSnapshot().draft.reminders).toEqual([expect.objectContaining({ message: 'Captured reminder' })]);
    expect(screen).toHavePathname('/');
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
  } finally { cleanup(); await h.db.closeAsync(); }
});

it.each(['pause', 'cover'] as const)('rejects an old delete confirmation after %s and return', async movement => {
  const { h, owner } = await setup('delete');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const rows = await h.db.getAllAsync('SELECT * FROM reminders');
    fireEvent.press(screen.getByTestId('delete-reminder'));
    const remove = alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Delete Reminder')!.onPress!;
    if (movement === 'pause') await act(async () => { await owner.suspend(); });
    else { act(() => router.push('/other' as Href)); await settle(); }
    act(() => { if (movement === 'pause') owner.resume(); else router.back(); }); await settle();
    act(() => remove()); await settle();
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual(rows);
    expect(screen).toHavePathname('/form');
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('stops a sample reminder route before database queries or native reminder inspection', async () => {
  const { h, read, auth } = await setup('create', true);
  try {
    expect(await screen.findByText('Reminders are unavailable in Sample mode.')).toBeOnTheScreen();
    expect(screen.queryByTestId('reminder-save')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  } finally { cleanup(); await h.db.closeAsync(); }
});

it('joins the actual native permission await and commits through the accepted core after pause', async () => {
  const { h, owner, auth } = await setup('create');
  const entered = gate(), response = gate();
  auth.mockImplementationOnce(async () => { entered.resolve(); await response.promise; return 'granted'; });
  let join: Promise<void> | undefined;
  try {
    fireEvent.press(screen.getByTestId('reminder-save')); await entered.promise;
    let joined = false;
    act(() => { join = owner.suspend(); void join.then(() => { joined = true; }); }); await settle();
    expect(joined).toBe(false);
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
    await act(async () => { response.resolve(); await join; }); await settle();
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toEqual([expect.objectContaining({ message: 'Captured reminder', schedule_state: 'scheduled' })]);
    expect(screen).toHavePathname('/form');
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    act(() => owner.resume()); await settle();
    expect(screen.getByText('Done')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Done')); await settle();
    expect(screen).toHavePathname('/');
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(receipts);
  } finally { await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
});

it('blocks native Back for an untouched pending reminder and permits it after completed resume', async () => {
  const { h, owner } = await setup('create', false, false);
  const entered = gate(), response = gate();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(commands, 'createReminder').mockImplementationOnce(async (...args) => {
    const result = await actual.create(...args); expect(result.ok).toBe(true);
    entered.resolve(); await response.promise; return result;
  });
  let join: Promise<void> | undefined;
  try {
    fireEvent.press(screen.getByTestId('reminder-save')); await entered.promise;
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/form');
    act(() => { join = owner.suspend(); });
    await act(async () => { response.resolve(); await join; }); await settle();
    act(() => owner.resume()); await settle();
    expect(screen.getByText('Done')).toBeOnTheScreen();
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/');
    expect(alert).not.toHaveBeenCalled();
    expect(await h.db.getAllAsync('SELECT * FROM reminders')).toHaveLength(1);
  } finally { await act(async () => { response.resolve(); await join; }); await settle(); cleanup(); await h.db.closeAsync(); }
});
