import { act, within } from '@testing-library/react-native';
import { router } from 'expo-router';

import { archiveBoard, createBoard, createCheckIn, restoreBoard } from '@/core/domain/commands';
import type { CreateBoardInput } from '@/core/domain/commands';
import { getStackListSnapshot } from '@/core/domain/stack-queries';
import * as stackQueries from '@/core/domain/stack-queries';
import { err } from '@/core/domain/result';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { formatMinuteOfDay } from '@/features/reminders/weekdays';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seed(title: string, fields: Partial<CreateBoardInput> = {}) {
  const result = await createBoard(await core(), {
    commandId: newCommandId(), title, kind: 'daily', symbol: 'star.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
    tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, ...fields,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

async function check(boardId: BoardId, date: string) {
  const result = await createCheckIn(await core(), { commandId: newCommandId(), boardId, logicalDate: date as LogicalDate, source: 'app' });
  if (!result.ok) throw new Error(result.error.message);
}

async function mixedStack() {
  mockClock.utcMs = Date.UTC(2026, 7, 31, 16);
  const root = await seed('Read', { kind: 'count', anchor: { kind: 'text', relation: 'after', text: 'getting home' } });
  const before = await seed('Make tea', { anchor: { kind: 'board', relation: 'before', boardId: root }, usualTimeMinute: 0 });
  const after = await seed('Reflect', { anchor: { kind: 'board', relation: 'after', boardId: root } });
  const optional = await seed('Sketch', { anchor: { kind: 'board', relation: 'after', boardId: root }, requiredInStack: false });
  mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
  for (const date of ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']) await check(before, date);
  for (const date of ['2026-09-03', '2026-09-04', '2026-09-07', '2026-09-07', '2026-09-08']) await check(root, date);
  for (const date of ['2026-09-04', '2026-09-07']) await check(after, date);
  await check(optional, '2026-09-08');
  return { root, before, after, optional };
}

describe('derived stack screens', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); });

  it('opens empty Stacks from Home and returns from the existing anchored-board creation flow', async () => {
    await seed('An isolated habit');
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('board-card-0');
    await press('open-stacks');
    expect(await screen.findByTestId('stacks-empty')).toHaveTextContent('Anchor a habit to another habit, a preset, or an event to build a stack.', { exact: false });
    await press('stacks-create-board');
    await screen.findByTestId('board-title-input');
    fireEvent.changeText(screen.getByTestId('board-title-input'), 'Morning stretch');
    await press('board-anchor-row');
    await press('anchor-preset-wake');
    await press('anchor-picker-done');
    await press('board-form-save');

    const list = await getStackListSnapshot(await core());
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value.stacks).toHaveLength(1);
    const card = await screen.findByTestId(`stack-card-${list.value.stacks[0].rootId}`);
    expect(card).toHaveTextContent('Morning stretch', { exact: false });
    expect(within(screen.getByTestId('stacks-list')).queryByText('An isolated habit')).toBeNull();
    expect(screen).toHavePathname('/stacks');
    act(() => router.back());
    await settle();
  });

  it('shows ordered state, midnight and weekly metrics, then keeps the root route when the first displayed member changes', async () => {
    const ids = await mixedStack();
    renderRouter('src/app', { initialUrl: '/stacks' });
    const card = await screen.findByTestId(`stack-card-${ids.root}`);
    expect(within(card).getAllByTestId(/^stack-member-/).map((row) => row.props.testID))
      .toEqual([ids.before, ids.root, ids.after, ids.optional].map((id) => `stack-member-${id}`));
    expect(card).toHaveTextContent(`Usual time: ${formatMinuteOfDay(0)}`, { exact: false });
    expect(card).toHaveTextContent('1 complete day this week', { exact: false });
    expect(card).toHaveTextContent('1-day streak', { exact: false });
    expect(within(card).getByTestId(`stack-member-${ids.root}`)).toHaveTextContent('Checked', { exact: false });
    expect(within(card).getByTestId(`stack-member-${ids.before}`)).toHaveTextContent('Not checked', { exact: false });
    expect(within(card).getByTestId(`stack-member-${ids.optional}`)).toHaveTextContent('Optional', { exact: false });
    await press(`stack-card-${ids.root}`);
    await screen.findByTestId('stack-detail');
    expect(screen).toHavePathname(`/stacks/${ids.root}`);

    act(() => router.push(`/boards/${ids.before}/edit`));
    await screen.findByTestId('board-anchor-row');
    await press('board-anchor-row');
    fireEvent(screen.getByTestId('anchor-relation-picker'), 'selectionChange', 'after');
    await press('anchor-picker-done');
    await press('board-form-save');
    expect(screen).toHavePathname(`/stacks/${ids.root}`);
    const members = within(screen.getByTestId('stack-detail')).getAllByTestId(/^stack-member-/);
    expect(members[0].props.testID).toBe(`stack-member-${ids.root}`);
    expect(within(screen.getByTestId('stack-detail')).getByText('No usual time')).toBeOnTheScreen();
  });

  it('renders 365 exact-date cells with four progress states, unavailable dates and raw Count weekly totals', async () => {
    const ids = await mixedStack();
    renderRouter('src/app', { initialUrl: `/stacks/${ids.root}` });
    await screen.findByTestId('stack-heatmap');
    expect(screen.getAllByTestId(/^stack-day-/)).toHaveLength(365);
    expect(screen.getByLabelText('2026-08-30, unavailable, no required habits')).toBeOnTheScreen();
    for (const [date, state, count] of [['2026-09-01', 'none', 0], ['2026-09-02', 'some', 1], ['2026-09-03', 'most', 2], ['2026-09-04', 'all', 3]]) {
      expect(screen.getByLabelText(`${date}, ${state}, ${count} of 3 required habits checked`)).toBeOnTheScreen();
    }
    expect(screen.getByLabelText('2026-09-08, some, 1 of 3 required habits checked, today')).toBeOnTheScreen();
    expect(screen.queryByTestId('stack-day-2026-09-09')).toBeNull();
    for (const date of ['2026-09-02', '2026-09-03', '2026-09-04']) expect(screen.getByTestId(`stack-marker-${date}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`stack-weekly-${ids.root}`)).toHaveTextContent('3 checks this week');
    expect(screen.getByTestId(`stack-weekly-${ids.before}`)).toHaveTextContent('1 checked day this week');
    expect(screen.getByTestId('stack-longest-streak')).toHaveTextContent('Longest streak1 day');
  });

  it('keeps an archived structural root route and hides archived members, then reports an all-archived stack as unavailable', async () => {
    const ids = await mixedStack();
    expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId: ids.root })).ok).toBe(true);
    renderRouter('src/app', { initialUrl: `/stacks/${ids.root}` });
    await screen.findByTestId('stack-detail');
    expect(screen).toHavePathname(`/stacks/${ids.root}`);
    expect(screen.queryByTestId(`stack-member-${ids.root}`)).toBeNull();
    expect(screen.getByTestId(`stack-member-${ids.before}`)).toBeOnTheScreen();
    for (const id of [ids.before, ids.after, ids.optional]) expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId: id })).ok).toBe(true);
    act(() => router.push('/stacks'));
    await screen.findByTestId('stacks-empty');
    act(() => router.push(`/stacks/${ids.root}`));
    expect(await screen.findByTestId('stack-error')).toHaveTextContent('This stack is no longer available.');
  });

  it('shows retained optional checks independently of availability and never calls an empty requirement set complete', async () => {
    mockClock.utcMs = Date.UTC(2026, 7, 31, 16);
    const root = await seed('Shifted routine', { anchor: { kind: 'preset', relation: 'after', preset: 'wake' }, requiredInStack: false, startOfDayMinute: 240 });
    const optional = await seed('Optional stretch', { anchor: { kind: 'board', relation: 'after', boardId: root }, requiredInStack: false });
    mockClock.utcMs = Date.UTC(2026, 8, 6, 16);
    await check(optional, '2026-09-06');
    expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId: optional })).ok).toBe(true);
    mockClock.utcMs = Date.UTC(2026, 8, 7, 5);
    expect((await restoreBoard(await core(), { commandId: newCommandId(), boardId: optional })).ok).toBe(true);
    const snapshot = await stackQueries.getStackDetailSnapshot(await core(), root);
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.stack.currentRun.logicalDate).toBe('2026-09-06');
    expect(snapshot.value.stack.members.find((member) => member.id === optional)).toMatchObject({ checked: true, eligible: false });
    renderRouter('src/app', { initialUrl: `/stacks/${root}` });
    await screen.findByTestId('stack-detail');
    expect(screen.getByText('No required habits for this date')).toBeOnTheScreen();
    expect(screen.getByTestId(`stack-member-${optional}`)).toHaveTextContent('Unavailable · Checked · Optional', { exact: false });
    expect(screen.getByText('0 complete days this week')).toBeOnTheScreen();
    expect(screen.getByLabelText('2026-09-06, unavailable, no required habits, today')).toBeOnTheScreen();
    expect(screen.queryByTestId('stack-marker-2026-09-06')).toBeNull();
  });

  it('keeps a detail storage failure distinct from an empty stack and supports explicit retry', async () => {
    const root = await seed('Recovered stack', { anchor: { kind: 'text', relation: 'after', text: 'lunch' } });
    jest.spyOn(stackQueries, 'getStackDetailSnapshot').mockResolvedValueOnce(err('database', 'The stack could not be read.', { retryable: true }));
    renderRouter('src/app', { initialUrl: `/stacks/${root}` });
    expect(await screen.findByTestId('stack-error')).toHaveTextContent('The stack could not be read.');
    expect(screen.queryByTestId('stack-detail')).toBeNull();
    await press('stack-retry');
    expect(await screen.findByTestId(`stack-member-${root}`)).toHaveTextContent('Recovered stack', { exact: false });
  });

  it('recovers a malformed stack link without querying a replacement root', async () => {
    const query = jest.spyOn(stackQueries, 'getStackDetailSnapshot');
    renderRouter('src/app', { initialUrl: '/stacks/not-a-uuid' });
    expect(await screen.findByText('This stack link is not valid.')).toBeOnTheScreen();
    expect(query).not.toHaveBeenCalled();
    await press('recovery-home');
    expect(screen).toHavePathname('/');
  });
});
