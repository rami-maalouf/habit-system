import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, router, Stack, ThemeProvider, type Href } from 'expo-router';
import { Alert, AppState, Linking, Text } from 'react-native';
import type { ComponentType } from 'react';

import { ProductPressable } from '@/features/ui';
import * as commands from '@/core/domain/commands';
import { NotificationsScreen } from '@/features/settings/notifications-screen';
import { notificationsPlatformMock, reminderScheduler } from '@/testing/notifications-platform.mock';
import { ImportScreen } from '@/features/settings/import-screen';

import { err } from '@/core/domain/result';
import { ProductProvider, useProduct } from '@/features/product-store';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import { AppIconScreen } from '@/features/settings/app-icon-screen';
import { ICloudScreen } from '@/features/settings/icloud-screen';
import { ExportScreen } from '@/features/settings/export-screen';
import * as icons from '@/platform/alternate-icons';
import * as sync from '@/platform/sync';
import * as transfer from '@/testing/data-transfer.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const CSV = `entity,board_id,board_name,board_amountKind,board_tracksCheckinTime,board_tracksPerformanceMetrics,board_defaultAmount,board_dayStartShiftSeconds,board_archivedAt,board_createdAt,checkin_id,checkin_boardId,checkin_amount,checkin_note,checkin_createdAt
Board,0C137BDE-BCB0-465B-8C9B-BE3E71774FA6,imported habit,,false,true,,0.0,,2026-05-04T02:06:28Z,,,,,
`;

function retainedPress(id: string): () => void {
  return screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === id)!.props.onPress;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('Settings effect scopes', () => {
  let harness: TestHarness;
  let product!: ReturnType<typeof useProduct>;
  beforeEach(async () => { jest.useFakeTimers(); notificationsPlatformMock.reset(); harness = await createTestHarness(); });
  afterEach(async () => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); await harness.db.closeAsync(); });

  async function mount(Screen: ComponentType) {
    const open = jest.fn(async () => err('database', 'test stops before sample allocation'));
    const session = new SampleSession(open);
    function Probe() { product = useProduct(); return <Screen />; }
    function Root() {
      return <ThemeProvider value={DefaultTheme}><SampleSessionProvider sessionOverride={session}>
        <ProductProvider coreOverride={harness.deps}><Stack /></ProductProvider>
      </SampleSessionProvider></ThemeProvider>;
    }
    renderRouter({ _layout: Root, index: Probe, other: () => <Text>Other scene</Text> });
    await settle();
    return { session, open };
  }


  it('does not export from an unmounted scene while the same provider scope remains active', async () => {
    const share = jest.spyOn(transfer, 'saveAndShareExport').mockResolvedValue({ ok: true, value: undefined });
    await mount(ExportScreen);
    const oldPress = retainedPress('export-start');
    const originalScope = product.scope;
    act(() => router.replace('/other' as Href)); await settle();
    expect(screen.getByText('Other scene')).toBeOnTheScreen();
    expect(originalScope.isCurrent()).toBe(true);
    const reads = jest.spyOn(harness.db, 'getAllAsync');
    const first = jest.spyOn(harness.db, 'getFirstAsync');
    act(() => oldPress()); await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it.each(['picker', 'confirm', 'retry', 'again'] as const)('does not adopt a later focus owner for a retained import %s callback', async stage => {
    const pick = jest.spyOn(transfer, 'pickImportFile').mockResolvedValue({ ok: true, value: { name: 'habits.csv', contents: CSV } });
    const actual = commands.importSnapshot;
    const submit = jest.spyOn(commands, 'importSnapshot');
    if (stage === 'retry') submit.mockImplementationOnce(async (...args) => {
      await actual(...args);
      return err('database', 'Response interrupted.', { retryable: true });
    });
    await mount(ImportScreen);
    if (stage !== 'picker') { fireEvent.press(screen.getByTestId('import-ripples')); await settle(); }
    if (stage === 'again' || stage === 'retry') { fireEvent.press(screen.getByTestId('import-confirm')); await settle(); }
    const id = stage === 'picker' ? 'import-ripples' : stage === 'confirm' || stage === 'retry' ? 'import-confirm' : 'import-again';
    const oldPress = retainedPress(id);
    const originalScope = product.scope;
    act(() => router.push('/other' as Href)); await settle();
    act(() => router.back()); await settle();
    expect(product.scope).toBe(originalScope);
    expect(originalScope.isCurrent()).toBe(true);
    pick.mockClear(); submit.mockClear();
    act(() => oldPress()); await settle();
    expect(pick).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByTestId(id)).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(id)); await settle();
    if (stage === 'picker') expect(pick).toHaveBeenCalledTimes(1);
    else if (stage === 'confirm' || stage === 'retry') expect(submit).toHaveBeenCalledTimes(1);
    else expect(screen.getByTestId('import-ripples')).toBeOnTheScreen();
  });


  it('joins a held picker but does not publish its file into the resumed chooser', async () => {
    const picked = deferred<Awaited<ReturnType<typeof transfer.pickImportFile>>>();
    const pick = jest.spyOn(transfer, 'pickImportFile').mockReturnValueOnce(picked.promise)
      .mockResolvedValue({ ok: true, value: { name: 'fresh.csv', contents: CSV } });
    const { session, open } = await mount(ImportScreen);
    fireEvent.press(screen.getByTestId('import-ripples')); await settle();
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { picked.resolve({ ok: true, value: { name: 'retired.csv', contents: CSV } }); await entering; });
    await act(async () => { await session.close(); }); await settle();
    expect(screen.queryByTestId('import-preview')).toBeNull();
    fireEvent.press(screen.getByTestId('import-ripples')); await settle();
    expect(pick).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('import-preview')).toHaveTextContent(/fresh.csv/);
  });

  it('finishes an admitted raw-core import during pause and reuses its actual receipt after a lost response', async () => {
    jest.spyOn(transfer, 'pickImportFile').mockResolvedValue({ ok: true, value: { name: 'habits.csv', contents: CSV } });
    const gate = deferred<void>();
    const actual = commands.importSnapshot;
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      await gate.promise;
      const result = await actual(...args);
      expect(result.ok).toBe(true);
      throw new Error('lost private response');
    });
    const { session, open } = await mount(ImportScreen);
    fireEvent.press(screen.getByTestId('import-ripples')); await settle();
    fireEvent.press(screen.getByTestId('import-confirm')); await settle();
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await entering; });
    expect(await harness.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'imported habit' }]);
    await act(async () => { await session.close(); }); await settle();
    expect(screen.getByTestId('import-confirm')).toHaveTextContent('Retry import');
    async function snapshot() {
      return Promise.all(['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'mutation_outbox', 'command_receipts', 'app_settings']
        .map(table => harness.db.getAllAsync(`SELECT * FROM ${table}`)));
    }
    const before = await snapshot();
    fireEvent.press(screen.getByTestId('import-confirm')); await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][1]).toEqual(submit.mock.calls[0][1]);
    expect(await snapshot()).toEqual(before);
    expect(screen.getByTestId('import-done')).toBeOnTheScreen();
  });

  it('joins icon compensation after an actual SQLite write rejection before publishing a sample baseline', async () => {
    jest.spyOn(icons, 'supportsAlternateIcons').mockResolvedValue(true);
    const rollback = deferred<void>();
    const change = jest.spyOn(icons, 'setAlternateIcon').mockResolvedValueOnce(undefined).mockReturnValueOnce(rollback.promise);
    const { session, open } = await mount(AppIconScreen);
    await harness.db.execAsync("CREATE TEMP TRIGGER reject_icon BEFORE UPDATE OF selected_icon ON app_settings WHEN NEW.selected_icon <> OLD.selected_icon BEGIN SELECT RAISE(FAIL, 'private icon write'); END");
    fireEvent.press(screen.getByRole('button', { name: 'Use Midnight icon' })); await settle();
    expect(change).toHaveBeenNthCalledWith(2, null);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { rollback.resolve(); await entering; });
    expect(await harness.db.getFirstAsync('SELECT selected_icon FROM app_settings')).toEqual({ selected_icon: 'default' });
    await act(async () => { await session.close(); }); await settle();
    expect(screen.getByRole('button', { name: 'Retry icon change' })).toBeOnTheScreen();
    expect(screen.queryByText(/private icon write/)).toBeNull();
  });

  it('joins native notification authorization and settings opening, then retires the old Open Settings callback', async () => {
    const auth = deferred<'denied'>();
    const read = jest.spyOn(reminderScheduler, 'authorization').mockReturnValueOnce(auth.promise).mockResolvedValue('denied');
    const opening = deferred<void>();
    const settings = jest.spyOn(Linking, 'openSettings').mockReturnValueOnce(opening.promise).mockResolvedValue(undefined);
    const { session, open } = await mount(NotificationsScreen);
    expect(read).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { auth.resolve('denied'); await entering; });
    await act(async () => { await session.close(); }); await settle();
    const oldPress = retainedPress('notifications-open-settings');
    fireEvent.press(screen.getByTestId('notifications-open-settings')); await settle();
    open.mockClear();
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { opening.resolve(); await entering; });
    await act(async () => { await session.close(); }); await settle();
    act(() => oldPress()); await settle();
    expect(settings).toHaveBeenCalledTimes(1);
    const currentPress = retainedPress('notifications-open-settings');
    act(() => router.replace('/other' as Href)); await settle();
    act(() => currentPress()); await settle();
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it.each(['icloud', 'notifications'] as const)('removes %s foreground inspection listeners on blur and rejects retained callbacks', async kind => {
    const inspect = kind === 'icloud' ? jest.spyOn(sync, 'cloudKitAvailable').mockResolvedValue(true)
      : jest.spyOn(reminderScheduler, 'authorization').mockResolvedValue('denied');
    const add = jest.spyOn(AppState, 'addEventListener');
    await mount(kind === 'icloud' ? ICloudScreen : NotificationsScreen);
    const count = inspect.mock.calls.length;
    const subscriptions = add.mock.results.map(result => result.value as { remove: () => void });
    const removed = subscriptions.map(subscription => jest.spyOn(subscription, 'remove'));
    const before = removed.map(remove => remove.mock.calls.length);
    const callbacks = add.mock.calls.map(call => call[1]);
    act(() => router.push('/other' as Href)); await settle();
    const retired = callbacks.filter((_, index) => removed[index].mock.calls.length > before[index]);
    expect(retired.length).toBeGreaterThan(0);
    act(() => { for (const callback of retired) callback('active'); }); await settle();
    expect(inspect).toHaveBeenCalledTimes(count);
    act(() => router.back()); await settle();
    expect(inspect).toHaveBeenCalledTimes(count + 1);
  });

  it('joins native icon confirmation and its actual selected-icon receipt across suspension', async () => {
    jest.spyOn(icons, 'supportsAlternateIcons').mockResolvedValue(true);
    const confirmation = deferred<void>();
    const change = jest.spyOn(icons, 'setAlternateIcon').mockResolvedValue(undefined).mockReturnValueOnce(confirmation.promise);
    const { session, open } = await mount(AppIconScreen);
    fireEvent.press(screen.getByRole('button', { name: 'Use Midnight icon' }));
    await settle();
    expect(change).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await settle();
    const early = open.mock.calls.length;
    await act(async () => { confirmation.resolve(); await entering; });
    await settle();
    expect(early).toBe(0);
    expect(await harness.db.getFirstAsync('SELECT selected_icon FROM app_settings')).toEqual({ selected_icon: 'midnight' });
    expect(change).toHaveBeenCalledTimes(1);
    await act(async () => { await session.close(); });
    expect(screen.getByRole('button', { name: 'Use Midnight icon', selected: true })).toBeOnTheScreen();
  });

  it('joins a held native account inspection before sample initialization', async () => {
    const availability = deferred<boolean>();
    const inspect = jest.spyOn(sync, 'cloudKitAvailable').mockResolvedValue(true).mockReturnValueOnce(availability.promise);
    const { session, open } = await mount(ICloudScreen);
    expect(inspect).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await settle();
    const early = open.mock.calls.length;
    await act(async () => { availability.resolve(true); await entering; });
    expect(early).toBe(0);
    await act(async () => { await session.close(); });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each(['scope', 'focus'] as const)('rejects an old iCloud confirmation after %s retirement without allocating or writing a command', async retired => {
    jest.spyOn(sync, 'cloudKitAvailable').mockResolvedValue(true);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { session } = await mount(ICloudScreen);
    fireEvent(screen.getByTestId('icloud-toggle'), 'valueChange', true);
    const confirm = alert.mock.calls[0][2]!.find(button => button.text === 'Turn On')!.onPress!;
    if (retired === 'scope') await act(async () => { await session.enter(); await session.close(); });
    else {
      act(() => router.push('/other' as Href)); await settle();
      act(() => router.back()); await settle();
    }
    const ids = jest.spyOn(harness.ids, 'uuid');
    const version = product.version;
    expect(() => act(() => confirm())).not.toThrow();
    await settle();
    expect(ids).not.toHaveBeenCalled();
    expect(product.version).toBe(version);
    expect(await harness.db.getFirstAsync('SELECT icloud_sync_enabled FROM app_settings')).toEqual({ icloud_sync_enabled: 0 });
  });

  it('joins export snapshot and native sharing without letting a queued second callback start another share', async () => {
    const sharing = deferred<Awaited<ReturnType<typeof transfer.saveAndShareExport>>>();
    const share = jest.spyOn(transfer, 'saveAndShareExport').mockReturnValue(sharing.promise);
    const { session, open } = await mount(ExportScreen);
    const button = screen.getByTestId('export-start');
    fireEvent.press(button); fireEvent.press(button);
    await settle();
    expect(share).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); });
    await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { sharing.resolve({ ok: true, value: undefined }); await entering; });
    expect(open).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
  });
});
