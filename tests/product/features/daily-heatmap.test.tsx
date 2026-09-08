import { act } from '@testing-library/react-native';
import { Dimensions, ScrollView } from 'react-native';

import { archiveBoard, createBoard, createCheckIn, restoreBoard, updateBoard } from '@/core/domain/commands';
import type { BoardKind } from '@/core/domain/entities';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { getBoardHeatmap } from '@/core/domain/queries';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { listBoardCheckInsForDate } from '@/core/persistence/repositories/check-ins';

import { deriveBoardColors } from '../../../src/features/boards/board-colors';
import { HeatmapView } from '../../../src/features/boards/heatmap-view';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderComponent, renderRouter, screen, settle } from '../../../src/testing/render';

const colors = deriveBoardColors('#70A7FF', 'light');
const defaultWindow = Dimensions.get('window');

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seedBoard(kind: BoardKind) {
  const result = await createBoard(await core(), {
    commandId: newCommandId(), title: 'calendar history', kind,
    symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
    tracksAmount: kind === 'count', amountUnit: 'pages', quickAmount: 3,
    tracksTime: kind === 'count', startOfDayMinute: 0, metricsEnabled: true,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function addCheck(boardId: BoardId, date: string, note: string) {
  const result = await createCheckIn(await core(), {
    commandId: newCommandId(), boardId, logicalDate: date as LogicalDate, note, source: 'app',
  });
  if (!result.ok) throw new Error(result.error.message);
}

async function setKind(boardId: BoardId, kind: BoardKind) {
  const deps = await core();
  const board = await getBoardById(deps.db, boardId);
  if (!board) throw new Error('missing board');
  const result = await updateBoard(deps, {
    ...board, commandId: newCommandId(), boardId, expectedMutationStamp: board.mutationStamp, kind,
  });
  if (!result.ok) throw new Error(result.error.message);
}

describe('Daily heatmap states', () => {
  beforeEach(() => resetProductCoreForTests());
  afterEach(() => {
    act(() => Dimensions.set({ window: defaultWindow }));
  });

  it.each(['count', 'daily'] as const)('renders a retained archived-gap check as unavailable for %s without losing history', async (kind) => {
    mockClock.utcMs = Date.UTC(2026, 7, 20, 16);
    const boardId = await seedBoard('count');
    mockClock.utcMs = Date.UTC(2026, 7, 22, 16);
    expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId })).ok).toBe(true);
    mockClock.utcMs = Date.UTC(2026, 7, 25, 16);
    expect((await restoreBoard(await core(), { commandId: newCommandId(), boardId })).ok).toBe(true);
    await addCheck(boardId, '2026-08-23', 'retained archived-gap history');
    await addCheck(boardId, '2026-08-23', 'second retained archived-gap note');
    if (kind === 'daily') await setKind(boardId, 'daily');
    const deps = await core();
    const before = await listBoardCheckInsForDate(deps.db, boardId, '2026-08-23' as LogicalDate);
    const projection = await getBoardHeatmap(deps, boardId);
    expect(projection.ok && projection.value?.weeks.flatMap((week) => week.days).find((cell) => cell.date === '2026-08-23'))
      .toMatchObject({ count: 2, intensity: 'medium', eligible: false });

    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('board-heatmap');

    expect(screen.getByLabelText('2026-08-23, unavailable')).toHaveStyle({ backgroundColor: colors.unavailableCell });
    expect(screen.queryByTestId('heatmap-marker-2026-08-23')).toBeNull();
    expect(await listBoardCheckInsForDate(deps.db, boardId, '2026-08-23' as LogicalDate)).toEqual(before);
  });

  it('converts Count intensity to identical Daily checked cells while retaining notes, amounts, and times', async () => {
    mockClock.utcMs = Date.UTC(2026, 7, 20, 16);
    const boardId = await seedBoard('count');
    mockClock.utcMs = Date.UTC(2026, 7, 25, 16);
    await addCheck(boardId, '2026-08-20', 'one completion');
    for (const note of ['first retained', 'second retained', 'third retained']) await addCheck(boardId, '2026-08-21', note);
    const deps = await core();
    const before = await listBoardCheckInsForDate(deps.db, boardId, '2026-08-21' as LogicalDate);
    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('board-heatmap');
    expect(screen.getByLabelText('2026-08-20, 1 check-ins')).toHaveStyle({ backgroundColor: `${colors.accent}66` });
    expect(screen.getByLabelText('2026-08-21, 3 check-ins')).toHaveStyle({ backgroundColor: colors.accent });
    expect(screen.getByTestId('heatmap-marker-2026-08-21')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('edit-board'));
    await settle();
    fireEvent(await screen.findByTestId('board-kind-picker'), 'selectionChange', 'daily');
    await settle();
    fireEvent.press(screen.getByTestId('board-form-save'));
    await settle();

    const single = screen.getByLabelText('2026-08-20, checked');
    const several = screen.getByLabelText('2026-08-21, checked');
    expect(single.props.style).toEqual(several.props.style);
    expect(single).toHaveStyle({ backgroundColor: colors.accent });
    expect(screen.getByTestId('heatmap-checked-2026-08-20')).toBeOnTheScreen();
    expect(screen.getByTestId('heatmap-checked-2026-08-21')).toBeOnTheScreen();
    expect(screen.queryByTestId('heatmap-marker-2026-08-21')).toBeNull();
    expect(screen.getByLabelText('2026-08-22, not checked')).toHaveStyle({ backgroundColor: colors.inactiveBar });
    expect(await listBoardCheckInsForDate(deps.db, boardId, '2026-08-21' as LogicalDate)).toEqual(before);
    const projection = await getBoardHeatmap(deps, boardId);
    expect(projection.ok && projection.value?.weeks.flatMap((week) => week.days).find((cell) => cell.date === '2026-08-21'))
      .toMatchObject({ count: 3, intensity: 'high', eligible: true });
  });

  it('distinguishes the rolling-window padding, eligible unchecked dates, today, and future', async () => {
    mockClock.utcMs = Date.UTC(2025, 7, 1, 16);
    const boardId = await seedBoard('daily');
    mockClock.utcMs = Date.UTC(2026, 7, 25, 16);
    await addCheck(boardId, '2026-08-25', 'today');
    renderRouter('src/app', { initialUrl: `/boards/${boardId}` });
    await screen.findByTestId('board-heatmap');

    expect(screen.getByLabelText('2025-08-25, unavailable')).toHaveStyle({ backgroundColor: colors.unavailableCell });
    expect(screen.getByLabelText('2025-08-26, not checked')).toHaveStyle({ backgroundColor: colors.inactiveBar });
    expect(screen.getByLabelText('2026-08-25, checked, today')).toHaveStyle({ borderWidth: 1.5, borderColor: colors.accent });
    expect(screen.getByLabelText('2026-08-26, future date')).toHaveStyle({ backgroundColor: colors.unavailableCell, opacity: 0.25 });
    expect(screen.queryByTestId('heatmap-checked-2026-08-26')).toBeNull();
  });

  it('does not scroll back to today after a completion refresh', async () => {
    const boardId = await seedBoard('daily');
    const deps = await core();
    const before = await getBoardHeatmap(deps, boardId);
    if (!before.ok || !before.value) throw new Error('missing heatmap');
    const rendered = renderComponent(<HeatmapView kind="daily" weeks={before.value.weeks} colors={colors} />);
    const scroll = rendered.UNSAFE_getByType(ScrollView).instance as ScrollView;
    expect(scroll.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    jest.mocked(scroll.scrollToEnd).mockClear();

    await addCheck(boardId, '2026-08-30', 'new completion');
    const refreshed = await getBoardHeatmap(deps, boardId);
    if (!refreshed.ok || !refreshed.value) throw new Error('missing refreshed heatmap');
    rendered.rerender(<HeatmapView kind="daily" weeks={refreshed.value.weeks} colors={colors} />);
    fireEvent(rendered.UNSAFE_getByType(ScrollView), 'contentSizeChange', 900, 700);

    expect(screen.getByLabelText('2026-08-30, checked, today')).toBeOnTheScreen();
    expect(scroll.scrollToEnd).not.toHaveBeenCalled();
  });

  it('keeps weekday rows aligned with cells as native text grows and returns to normal size', async () => {
    const boardId = await seedBoard('daily');
    await addCheck(boardId, '2026-08-30', 'completed today');
    const projection = await getBoardHeatmap(await core(), boardId);
    if (!projection.ok || !projection.value) throw new Error('missing heatmap');
    const rendered = renderComponent(<HeatmapView kind="daily" weeks={projection.value.weeks} colors={colors} />);
    const scroll = rendered.UNSAFE_getByType(ScrollView).instance as ScrollView;
    jest.mocked(scroll.scrollToEnd).mockClear();
    const normalHeight = screen.getByLabelText('2026-08-30, checked, today').props.style.height;

    act(() => Dimensions.set({ window: { ...defaultWindow, fontScale: 3 } }));
    const scaledHeight = screen.getByLabelText('2026-08-30, checked, today').props.style.height;
    expect(scaledHeight).toBeGreaterThan(normalHeight);
    fireEvent(screen.getByText('Mon'), 'textLayout', { nativeEvent: { lines: [{ height: 48 }] } });
    const measuredHeight = screen.getByLabelText('2026-08-30, checked, today').props.style.height;
    expect(measuredHeight).toBeGreaterThanOrEqual(48);
    for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByTestId(`heatmap-weekday-${label}`)).toHaveStyle({ height: measuredHeight });
    }
    expect(screen.getByText('Mon').props.allowFontScaling).not.toBe(false);
    fireEvent(rendered.UNSAFE_getByType(ScrollView), 'contentSizeChange', 900, 109);
    expect(scroll.scrollToEnd).not.toHaveBeenCalled();
    fireEvent(rendered.UNSAFE_getByType(ScrollView), 'contentSizeChange', 2600, 354);
    expect(scroll.scrollToEnd).toHaveBeenCalledTimes(1);
    jest.mocked(scroll.scrollToEnd).mockClear();
    fireEvent(rendered.UNSAFE_getByType(ScrollView), 'contentSizeChange', 2650, 354);
    expect(scroll.scrollToEnd).not.toHaveBeenCalled();

    act(() => Dimensions.set({ window: defaultWindow }));
    expect(screen.getByLabelText('2026-08-30, checked, today')).toHaveStyle({ height: normalHeight });
    expect(screen.getByTestId('heatmap-weekday-Mon')).toHaveStyle({ height: normalHeight });
    fireEvent(rendered.UNSAFE_getByType(ScrollView), 'contentSizeChange', 900, 109);
    expect(scroll.scrollToEnd).not.toHaveBeenCalled();
  });
});
