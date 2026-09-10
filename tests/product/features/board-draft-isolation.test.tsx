import { observeProductCore } from '@/testing/observe-product-core';
import { act, cleanup, within } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, type Href } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';
import { Alert, Text, View } from 'react-native';

import OptionsRoute from '@/app/(product)/boards/[boardId]/options';
import ReminderRoute from '@/app/(product)/boards/[boardId]/reminders/new';
import { BoardFormScreen } from '@/features/board-configuration/board-form-screen';
import { draftStoreFor, newBoardDraft } from '@/features/board-configuration/draft-store';
import { ProductProvider } from '@/features/product-store';
import { ProductPressable } from '@/features/ui';
import { listActiveBoards, listBoardReminders } from '@/core/domain/queries';
import * as boardQueries from '@/core/domain/queries';
import { createBoard } from '@/core/domain/commands';
import * as boardCommands from '@/core/domain/commands';
import { getProductCore, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness } from '../helpers/test-db';

let renderedCore: ReturnType<typeof observeProductCore>;
afterEach(() => renderedCore.restore());

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const actualRoutes = getMockContext('src/app');
for (const key of actualRoutes.keys()) actualRoutes(key);

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return result.value;
}

beforeEach(() => { resetProductCoreForTests(); notificationsPlatformMock.reset(); alertSpy.mockClear(); renderedCore = observeProductCore(); });

it('publishes only within its core and rejects ended, inactive and replaced owners', async () => {
  const first = await createTestHarness();
  const second = await createTestHarness();
  try {
    const store = draftStoreFor(first.deps);
    const other = draftStoreFor(second.deps);
    const changed = jest.fn();
    const otherChanged = jest.fn();
    const unsubscribe = store.subscribe(changed);
    const unsubscribeOther = other.subscribe(otherChanged);
    expect(draftStoreFor(first.deps)).toBe(store);
    store.begin('loading');
    expect(store.update('loading', { title: 'Before loaded' })).toBe(false);
    expect(store.update(null, { title: 'No owner' })).toBe(false);
    store.start(newBoardDraft(), 'loading');
    expect(store.update('loading', { title: 'First draft' })).toBe(true);
    const firstDraft = store.getSnapshot();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(otherChanged).not.toHaveBeenCalled();
    other.begin('other'); other.start(newBoardDraft(), 'other');
    expect(other.update('other', { title: 'Second draft' })).toBe(true);
    expect(store.getSnapshot()).toBe(firstDraft);
    expect(changed).toHaveBeenCalledTimes(3);
    store.begin('successor'); store.start(newBoardDraft(), 'successor');
    const successor = store.getSnapshot();
    store.end('loading');
    expect(store.update('loading', { title: 'Stale title' })).toBe(false);
    expect(store.getSnapshot()).toBe(successor);
    store.end('successor');
    expect(store.update('successor', { title: 'Ended title' })).toBe(false);
    expect(store.owns('successor', null)).toBe(false);
    expect(other.getSnapshot().draft.title).toBe('Second draft');
    unsubscribe(); unsubscribeOther();
    const calls = [changed.mock.calls.length, otherChanged.mock.calls.length];
    store.begin('next'); other.end('other');
    expect([changed.mock.calls.length, otherChanged.mock.calls.length]).toEqual(calls);
  } finally {
    await first.db.closeAsync(); await second.db.closeAsync();
  }
});

it('retains a mounted real draft through another core form and saves only its own board and reminder', async () => {
  const real = await createTestHarness();
  const sample = await createTestHarness();
  const realCore = real.deps;
  const sampleCore = sample.deps;
  function Root() {
    return <ThemeProvider value={DefaultTheme}><ProductProvider coreOverride={realCore}><Stack>
      <Stack.Screen name="scratch-sample" options={{ presentation: 'modal' }} />
    </Stack></ProductProvider></ThemeProvider>;
  }
  function RealForm() {
    return <View testID="real-draft-scene" style={{ flex: 1 }}>
      <ProductPressable label="Cover with second core" testID="cover-draft" onPress={() => router.push('/scratch-sample' as Href)}><Text>Cover</Text></ProductPressable>
      <BoardFormScreen boardId={null} />
    </View>;
  }
  function SampleLayout() { return <ProductProvider coreOverride={sampleCore}><Stack /></ProductProvider>; }
  function SampleForm() { return <View testID="sample-draft-scene" style={{ flex: 1 }}><BoardFormScreen boardId={null} /></View>; }
  try {
    // only this test map adds the covering route; all editor bodies and child
    // routes are actual components, using real commands and separate sqlite cores.
    renderRouter({ _layout: Root, index: () => <Text>Boards destination</Text>,
      'boards/new': RealForm, 'boards/[boardId]/options': OptionsRoute,
      'boards/[boardId]/reminders/new': ReminderRoute,
      'scratch-sample/_layout': SampleLayout, 'scratch-sample/index': SampleForm,
    }, { initialUrl: '/' });
    act(() => router.push('/boards/new')); await settle();
    fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Retained real title');
    await press('open-options');
    fireEvent(screen.getByTestId('metrics-toggle'), 'valueChange', false);
    await press('options-back');
    await press('add-reminder-row');
    fireEvent.changeText(await screen.findByTestId('reminder-message'), 'Retained real reminder');
    await press('reminder-save');
    expect(screen.getByTestId('draft-reminder-0')).toBeOnTheScreen();
    const realFacade = renderedCore.for(realCore);
    await press('cover-draft');
    const sampleScene = within(await screen.findByTestId('sample-draft-scene'));
    const sampleFacade = renderedCore.for(sampleCore);
    expect(realFacade.ids).toBe(realCore.ids);
    expect(sampleFacade.ids).toBe(sampleCore.ids);
    expect(sampleFacade).not.toBe(realFacade);
    expect(await sampleScene.findByTestId('board-title-input')).toHaveDisplayValue('');
    expect(sampleScene.queryByTestId('draft-reminder-0')).toBeNull();
    fireEvent.changeText(sampleScene.getByTestId('board-title-input'), 'Discarded sample title');
    act(() => router.back()); await settle();
    const discard = alertSpy.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Discard');
    expect(discard?.onPress).toBeDefined();
    act(() => discard!.onPress!()); await settle();
    expect(screen).toHavePathname('/boards/new');
    expect(renderedCore.for(realCore)).toBe(realFacade);
    const realScene = within(screen.getByTestId('real-draft-scene'));
    expect(await realScene.findByTestId('board-title-input')).toHaveDisplayValue('Retained real title');
    expect(realScene.getByTestId('draft-reminder-0')).toBeOnTheScreen();
    await press('open-options');
    expect(screen.getByTestId('metrics-toggle')).toHaveProp('value', false);
    await press('options-back');
    await press('board-form-save');
    expect(screen).toHavePathname('/');
    const boards = value(await listActiveBoards(realCore));
    expect(boards).toHaveLength(1);
    expect(boards[0]).toMatchObject({ title: 'Retained real title', metricsEnabled: false });
    expect(value(await listBoardReminders(realCore, boards[0].id))).toEqual([
      expect.objectContaining({ message: 'Retained real reminder', minuteOfDay: 540 }),
    ]);
    expect(value(await listActiveBoards(sampleCore))).toEqual([]);
    expect(await sample.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
  } finally {
    cleanup();
    await real.db.closeAsync(); await sample.db.closeAsync();
  }
});

it('ignores a captured Save after a successor form takes the same core', async () => {
  const core = value(await getProductCore());
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('create-board'); await press('create-board');
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Old owner title');
  const staleSave = screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === 'board-form-save')!.props.onPress;
  act(() => router.push('/boards/new?session=successor')); await settle();
  fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
  const store = draftStoreFor(renderedCore.for(core));
  const before = store.getSnapshot();
  const receipts = await core.db.getAllAsync('SELECT * FROM command_receipts');
  await act(async () => { await staleSave(); }); await settle();
  expect(value(await listActiveBoards(core))).toEqual([]);
  expect(await core.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
  expect(store.getSnapshot()).toBe(before);
  expect(screen).toHavePathname('/boards/new');
  expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
});

it.each(['archive', 'delete'] as const)('ignores a held %s confirmation after its board draft owner retires', async operation => {
  const core = value(await getProductCore());
  const created = value(await createBoard(core, { commandId: newCommandId(), title: 'Retain this board', kind: 'daily',
    symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true }));
  renderRouter('src/app', { initialUrl: `/boards/${created.boardId}/edit` });
  await screen.findByTestId('board-title-input');
  await press(operation === 'archive' ? 'archive-board' : 'form-delete-board');
  const confirm = alertSpy.mock.calls.at(-1)![2]!.find(button => button.text === (operation === 'archive' ? 'Archive' : 'Delete Board'))!.onPress!;
  act(() => router.push('/boards/new')); await settle();
  fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
  const boards = await core.db.getAllAsync('SELECT * FROM boards');
  const receipts = await core.db.getAllAsync('SELECT * FROM command_receipts');
  const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
  act(() => confirm()); await settle();
  expect(await core.db.getAllAsync('SELECT * FROM boards')).toEqual(boards);
  expect(await core.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
  expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
  expect(screen).toHavePathname('/boards/new');
});

it('ignores a captured options change after the same core starts a successor draft', async () => {
  const core = value(await getProductCore());
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('create-board'); await press('create-board');
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Old owner');
  await press('open-options');
  const staleChange = screen.getByLabelText('Start of day shift').props.onAccessibilityAction;
  act(() => router.push('/boards/new')); await settle();
  fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
  const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
  act(() => staleChange({ nativeEvent: { actionName: 'increment' } })); await settle();
  expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
  expect(before.draft.startOfDayMinute).toBe(0);
  expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
});

it('ignores the old options Back header after the same core starts a successor draft', async () => {
  const core = value(await getProductCore());
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('create-board'); await press('create-board');
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Old owner');
  await press('open-options');
  const staleBack = screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === 'options-back')!.props.onPress;
  act(() => router.push('/boards/new')); await settle();
  fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
  const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
  const alerts = alertSpy.mock.calls.length;
  act(() => staleBack()); await settle();
  expect(alertSpy).toHaveBeenCalledTimes(alerts);
  expect(screen).toHavePathname('/boards/new');
  expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
  expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
});

it.each(['save', 'delete', 'discard'] as const)('ignores a held unsaved reminder %s after a successor owns its index', async operation => {
  const core = value(await getProductCore());
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('create-board'); await press('create-board');
  fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Old owner');
  await press('add-reminder-row');
  fireEvent.changeText(await screen.findByTestId('reminder-message'), 'Old reminder');
  await press('reminder-save');
  await press('draft-reminder-0');
  fireEvent.changeText(await screen.findByTestId('reminder-message'), 'Stale replacement');
  let delayed: () => void;
  if (operation === 'save') {
    delayed = screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === 'reminder-save')!.props.onPress;
  } else {
    await press(operation === 'delete' ? 'delete-reminder' : 'reminder-cancel');
    delayed = alertSpy.mock.calls.at(-1)![2]!.find(button => button.text === (operation === 'delete' ? 'Delete Reminder' : 'Discard'))!.onPress!;
  }
  act(() => router.push('/boards/new')); await settle();
  fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
  await press('add-reminder-row');
  fireEvent.changeText(await screen.findByTestId('reminder-message'), 'Successor reminder');
  await press('reminder-save');
  const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
  expect(before.draft.reminders).toEqual([expect.objectContaining({ message: 'Successor reminder' })]);
  const alertCount = alertSpy.mock.calls.length;
  act(() => delayed()); await settle();
  expect(alertSpy).toHaveBeenCalledTimes(alertCount);
  expect(screen).toHavePathname('/boards/new');
  expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
  expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
  expect(screen.getByTestId('draft-reminder-0')).toBeOnTheScreen();
  expect(await core.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
  expect(await core.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
});

it('keeps a successor draft and route when an older edit receives its committed success', async () => {
  const core = value(await getProductCore());
  const created = value(await createBoard(core, { commandId: newCommandId(), title: 'Original board', kind: 'daily',
    symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true }));
  const actualUpdate = boardCommands.updateBoard;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const update = jest.spyOn(boardCommands, 'updateBoard').mockImplementationOnce(async (...args) => {
    const result = await actualUpdate(...args);
    expect(result.ok).toBe(true);
    await response;
    return result;
  });
  try {
    renderRouter('src/app', { initialUrl: `/boards/${created.boardId}/edit` });
    fireEvent.changeText(await screen.findByTestId('board-title-input'), 'Committed title');
    await press('board-form-save');
    const committed = await core.db.getFirstAsync<{ title: string }>('SELECT title FROM boards WHERE id = ?', [created.boardId]);
    expect(committed?.title).toBe('Committed title');
    act(() => router.push('/boards/new')); await settle();
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
    const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
    const alerts = alertSpy.mock.calls.length;
    await act(async () => { release(); }); await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(alerts);
    expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
    expect(screen).toHavePathname('/boards/new');
    expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
    expect(value(await listActiveBoards(core))).toEqual([expect.objectContaining({ id: created.boardId, title: 'Committed title' })]);
  } finally {
    release(); update.mockRestore();
  }
});

it('does not let an older edit first read claim a successor draft', async () => {
  const core = value(await getProductCore());
  const created = value(await createBoard(core, { commandId: newCommandId(), title: 'Slow board', kind: 'daily',
    symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true }));
  const actualRead = boardQueries.getBoard;
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  const read = jest.spyOn(boardQueries, 'getBoard').mockImplementationOnce(async (...args) => {
    const result = await actualRead(...args);
    expect(result.ok).toBe(true);
    await response;
    return result;
  });
  try {
    renderRouter('src/app', { initialUrl: `/boards/${created.boardId}/edit` });
    await screen.findByTestId('board-form-loading');
    act(() => router.push('/boards/new')); await settle();
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Successor title');
    const before = draftStoreFor(renderedCore.for(core)).getSnapshot();
    await act(async () => { release(); }); await settle();
    expect(draftStoreFor(renderedCore.for(core)).getSnapshot()).toBe(before);
    expect(screen).toHavePathname('/boards/new');
    expect(screen.getByTestId('board-title-input')).toHaveDisplayValue('Successor title');
    expect(value(await listActiveBoards(core))).toEqual([expect.objectContaining({ title: 'Slow board' })]);
  } finally {
    release(); read.mockRestore();
  }
});
