import { cleanup } from '@testing-library/react-native';
import { getMockContext } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import { getGroupedCheckInHistory } from '@/core/domain/queries';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { notificationsPlatformMock } from '@/testing/notifications-platform.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

type Picker = { value: Date; mode?: string; testID?: string; timeZoneName?: string; maximumDate?: Date;
  onValueChange: (event: unknown, value: Date) => void };
const mockPickers = new Map<string, Picker & { displayZone: string; boundZone: string }>();

// model only the installed native boundary: ios honors its zone environment;
// android uses utc dates and device-local clock values.
jest.mock('@expo/ui/community/datetime-picker', () => {
  const { Platform, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DateTimePicker(props: Picker) {
    const displayZone = Platform.OS === 'ios' && props.timeZoneName
      ? props.timeZoneName : Platform.OS === 'android' && props.mode === 'date'
        ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const boundZone = Platform.OS === 'android'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone : displayZone;
    mockPickers.set(props.testID!, { ...props, displayZone, boundZone });
    const civilDay = (value: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA',
      { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
    const onValueChange = (event: unknown, value: Date) => {
      // installed android converts bounds through host calendar civil parts,
      // while its selecteddate millis represent utc midnight.
      if (props.mode === 'date' && props.maximumDate &&
          civilDay(value, displayZone) > civilDay(props.maximumDate, boundZone)) return;
      props.onValueChange(event, value);
    };
    const format = new Intl.DateTimeFormat('en-CA', props.mode === 'time'
      ? { timeZone: displayZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { timeZone: displayZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return <Text testID={props.testID} {...({ onValueChange } as Record<string, unknown>)}>
      {format.format(props.value)}
    </Text>;
  } };
});

const routes = getMockContext('src/app');
for (const key of routes.keys()) routes(key);

async function seed(startOfDayMinute = 0, now = '2026-09-09T16:00:00Z') {
  mockClock.zone = 'America/Toronto';
  mockClock.utcMs = Date.parse('2026-01-01T17:00:00Z');
  const opened = await getProductCore();
  if (!opened.ok) throw Error(opened.error.message);
  const core = opened.value;
  const created = await createBoard(core, {
    commandId: newCommandId(), title: 'Picker zone Count', kind: 'count',
    symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
    tracksAmount: false, tracksTime: true, startOfDayMinute, metricsEnabled: true,
  });
  if (!created.ok) throw Error(created.error.message);
  mockClock.utcMs = Date.parse(now);
  renderRouter('src/app', { initialUrl: `/boards/${created.value.boardId}/check-ins` });
  fireEvent.press(await screen.findByText('Add Check-In')); await settle();
  await screen.findByTestId('check-in-time');
  return { core, boardId: created.value.boardId };
}

async function select(testID: string, date: string, hour: number, minute = 0, torontoOffset = '-04:00') {
  const picker = mockPickers.get(testID)!;
  const [year, month, day] = date.split('-').map(Number);
  const value = picker.displayZone === 'America/Toronto' && !(Platform.OS === 'android' && picker.mode === 'date')
    ? new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${torontoOffset}`)
    : Platform.OS === 'android' && picker.mode === 'date'
      ? new Date(Date.UTC(year, month - 1, day))
      : Platform.OS === 'android' && picker.mode === 'time'
        ? new Date(new Date(picker.value).setHours(hour, minute, 0, 0))
        : new Date(year, month - 1, day, hour, minute);
  fireEvent(screen.getByTestId(testID), 'valueChange',
    { nativeEvent: { timestamp: value.getTime(), utcOffset: -value.getTimezoneOffset() } }, value);
  await settle();
}

async function saveAndReopen(context: Awaited<ReturnType<typeof seed>>, date: string, instant: string, time: string, offsetMinutes = -240, timeZoneId = 'America/Toronto') {
  fireEvent.press(screen.getByTestId('check-in-save')); await settle();
  expect(screen).toHavePathname(`/boards/${context.boardId}/check-ins`);
  const result = await getGroupedCheckInHistory(context.core, context.boardId);
  if (!result.ok) throw Error(result.error.message);
  const records = result.value.months.flatMap(month => month.days.flatMap(day => day.checkIns));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ logicalDate: date, occurredAtUtc: Date.parse(instant), timeZoneId, offsetMinutes });
  const rows = await context.core.db.getAllAsync('SELECT occurred_at_utc, logical_date, time_zone_id, offset_minutes FROM check_ins WHERE board_id = ?', [context.boardId]);
  expect(rows).toEqual([{ occurred_at_utc: Date.parse(instant), logical_date: date, time_zone_id: timeZoneId, offset_minutes: offsetMinutes }]);
  fireEvent.press(screen.getByText(/^Picker zone Count(?: ✎)?$/)); await settle();
  await screen.findByTestId('delete-check-in');
  expect(screen).toHavePathname(`/boards/${context.boardId}/check-ins/${records[0].id}`);
  expect(screen.getByTestId('check-in-date')).toHaveTextContent(date, { exact: true });
  expect(screen.getByTestId('check-in-time')).toHaveTextContent(time, { exact: true });
}

describe.each(['ios', 'android'] as const)('%s picker civil time in a Toronto core', platform => {
  beforeEach(() => {
    resetProductCoreForTests(); notificationsPlatformMock.reset(); mockPickers.clear();
    jest.replaceProperty(Platform, 'OS', platform);
  });
  afterEach(() => { cleanup(); jest.restoreAllMocks(); });

  it('preserves untouched Toronto noon through Save and actual history reopen', async () => {
    const context = await seed();
    expect(screen.getByTestId('check-in-time')).toHaveTextContent('12:00', { exact: true });
    await saveAndReopen(context, '2026-09-09', '2026-09-09T16:00:00Z', '12:00');
  });

  it('saves historical September 8 displayed noon in Toronto', async () => {
    const context = await seed();
    await select('check-in-date', '2026-09-08', 12);
    expect(screen.getByTestId('check-in-time')).toHaveTextContent('12:00', { exact: true });
    await saveAndReopen(context, '2026-09-08', '2026-09-08T16:00:00Z', '12:00');
  });

  it('saves a selected 13:17 in Toronto instead of the host zone', async () => {
    const context = await seed();
    await select('check-in-time', '2026-09-09', 13, 17);
    await saveAndReopen(context, '2026-09-09', '2026-09-09T17:17:00Z', '13:17');
  });

  it('keeps a current 00:30 occurrence and its date ceiling inside the shifted day', async () => {
    const context = await seed(60, '2026-09-09T04:30:00Z');
    expect(screen.getByTestId('check-in-date')).toHaveTextContent('2026-09-08', { exact: true });
    const picker = mockPickers.get('check-in-date')!;
    expect(new Intl.DateTimeFormat('en-CA', {
      timeZone: picker.boundZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(picker.maximumDate!)).toBe('2026-09-08');
    await saveAndReopen(context, '2026-09-08', '2026-09-09T04:30:00Z', '00:30');
  });

  it('can choose a past date and return to logical today through native date bounds', async () => {
    const context = await seed(60, '2026-09-09T04:30:00Z');
    await select('check-in-date', '2026-09-07', 12);
    expect(screen.getByTestId('check-in-date')).toHaveTextContent('2026-09-07', { exact: true });
    await select('check-in-date', '2026-09-08', 12);
    expect(screen.getByTestId('check-in-date')).toHaveTextContent('2026-09-08', { exact: true });
    await saveAndReopen(context, '2026-09-08', '2026-09-09T04:30:00Z', '00:30');
  });

  it('recombines an early clock onto the next civil day inside its selected logical day', async () => {
    const context = await seed(60);
    await select('check-in-date', '2026-09-08', 12);
    await select('check-in-time', '2026-09-08', 0, 30);
    await saveAndReopen(context, '2026-09-08', '2026-09-09T04:30:00Z', '00:30');
  });

  it('preserves the inherited start-of-day fallback when a shifted time falls in the Toronto gap', async () => {
    const context = await seed(180, '2026-03-10T16:00:00Z');
    await select('check-in-date', '2026-03-07', 12, 0, '-05:00');
    await select('check-in-time', '2026-03-07', 2, 30, '-05:00');
    await saveAndReopen(context, '2026-03-07', '2026-03-07T08:00:00Z', '03:00', -300);
  });

  it('preserves the stored wall clock, instant, zone and offset on a note-only edit after travel', async () => {
    const context = await seed();
    await saveAndReopen(context, '2026-09-09', '2026-09-09T16:00:00Z', '12:00');
    fireEvent.press(screen.getByTestId('check-in-cancel')); await settle();
    mockClock.zone = 'Asia/Tokyo';
    fireEvent.press(screen.getByText(/^Picker zone Count(?: ✎)?$/)); await settle();
    expect(screen.getByTestId('check-in-time')).toHaveTextContent('12:00', { exact: true });
    fireEvent.changeText(screen.getByTestId('check-in-note'), 'same occurrence after travel');
    await saveAndReopen(context, '2026-09-09', '2026-09-09T16:00:00Z', '12:00');
    const rows = await context.core.db.getAllAsync('SELECT note FROM check_ins');
    expect(rows).toEqual([{ note: 'same occurrence after travel' }]);
  });

  it('captures an explicitly changed stored clock in the current product zone after travel', async () => {
    const context = await seed();
    await saveAndReopen(context, '2026-09-09', '2026-09-09T16:00:00Z', '12:00');
    fireEvent.press(screen.getByTestId('check-in-cancel')); await settle();
    mockClock.zone = 'Asia/Tokyo';
    fireEvent.press(screen.getByText(/^Picker zone Count(?: ✎)?$/)); await settle();
    expect(screen.getByTestId('check-in-time')).toHaveTextContent('12:00', { exact: true });
    await select('check-in-time', '2026-09-09', 13, 17);
    expect(screen.getByTestId('check-in-time')).toHaveTextContent('13:17', { exact: true });
    await saveAndReopen(context, '2026-09-09', '2026-09-09T04:17:00Z', '13:17', 540, 'Asia/Tokyo');
  });

  if (platform === 'ios' || Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Toronto') {
    it('keeps the exact second repeated 01:30 selected natively', async () => {
      const context = await seed(0, '2026-11-03T17:00:00Z');
      await select('check-in-date', '2026-11-01', 12, 0, '-05:00');
      await select('check-in-time', '2026-11-01', 1, 30, '-05:00');
      await saveAndReopen(context, '2026-11-01', '2026-11-01T06:30:00Z', '01:30', -300);
    });

    it('drops the repeated occurrence instant when its date changes', async () => {
      const context = await seed(0, '2026-11-03T17:00:00Z');
      await select('check-in-date', '2026-11-01', 12, 0, '-05:00');
      await select('check-in-time', '2026-11-01', 1, 30, '-05:00');
      await select('check-in-date', '2026-10-31', 12);
      await saveAndReopen(context, '2026-10-31', '2026-10-31T05:30:00Z', '01:30');
    });
  }

});
