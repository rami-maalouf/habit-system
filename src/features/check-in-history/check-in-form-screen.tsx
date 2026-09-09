import {
  BottomSheet,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Alert, Platform, ScrollView, TextInput, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import {
  addDays, currentLogicalDate, localDateOfInstant, localWallClock, parseLogicalDate, toLogicalDate,
} from '@/core/calendar/logical-date';
import { createOffsetSecondsReader } from '@/core/calendar/time-zone-offset';
import { createCheckIn, removeCheckIn, updateCheckIn } from '@/core/domain/commands';
import type { Board, CheckIn } from '@/core/domain/entities';
import type { BoardId, CheckInId, LogicalDate } from '@/core/domain/ids';
import type { DomainError } from '@/core/domain/result';
import { getBoard, getCheckIn } from '@/core/domain/queries';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { BoardSymbol, deriveBoardColors } from '../boards';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { useProductRouter } from '../sample/navigation';

type CheckInFormScreenProps = {
  boardId: BoardId;
  source?: 'app' | 'widget';
  // null creates a new check-in; otherwise the existing record is edited
  checkInId: CheckInId | null;
};
type RetainedEditor = { board: Board; record: CheckIn | null };

// exactInstant preserves the picker's own instant so an ambiguous wall
// clock (the repeated hour of a backward dst shift) keeps the occurrence
// the user actually selected; it is dropped once the date changes
type TimeOfDay = { hour: number; minute: number; exactInstant: number | null };

function utcWallTime(date: LogicalDate, hour: number, minute: number): number {
  const { year, month, day } = parseLogicalDate(date);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, 0, 0);
  return value.getTime();
}

// resolve civil time in the product zone, independent of the host date zone.
// like date construction, prefer the first repeated time and move gaps forward.
function civilInstant(date: LogicalDate, hour: number, minute: number, zone: string): number {
  const wall = utcWallTime(date, hour, minute);
  const offset = createOffsetSecondsReader(zone);
  const offsets = new Set([-86400000, 0, 86400000].map((delta) => offset(wall + delta)));
  const candidates = [...offsets].map((seconds) => wall - seconds * 1000).sort((a, b) => a - b);
  return candidates.find((instant) => instant + offset(instant) * 1000 === wall)
    ?? candidates[candidates.length - 1];
}

function dateFromLogical(date: LogicalDate, zone: string): Date {
  // material3 dates are utc midnights; swiftui dates use the explicit zone.
  return new Date(Platform.OS === 'android'
    ? utcWallTime(date, 0, 0) : civilInstant(date, 12, 0, zone));
}

function dateCeiling(date: LogicalDate, zone: string): Date {
  if (Platform.OS !== 'android') return dateFromLogical(date, zone);
  // the android wrapper converts bounds from host civil parts to utc days.
  const { year, month, day } = parseLogicalDate(date);
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(12, 0, 0, 0);
  return value;
}

function logicalFromDate(value: Date, zone: string): LogicalDate {
  return Platform.OS === 'android'
    ? toLogicalDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
    : localDateOfInstant(value.getTime(), zone);
}

// the wall-clock time a stored instant showed in its own recorded zone
function timeOfDayFromInstant(instantMs: number, timeZoneId: string): TimeOfDay {
  const { hour, minute } = localWallClock(instantMs, timeZoneId);
  return { hour, minute, exactInstant: instantMs };
}

// the product-zone instant for a logical date at a wall-clock time; the
// occurrence always belongs to the selected logical date under the board's
// start-of-day shift, never to "now"
function instantFor(
  date: LogicalDate,
  time: TimeOfDay,
  timeZoneId: string,
  startOfDayMinute: number,
): number {
  if (
    time.exactInstant !== null &&
    // the picker's own instant is authoritative while it still belongs to
    // the selected logical date: it disambiguates the repeated dst hour and
    // keeps early-morning occurrences inside a shifted day intact
    currentLogicalDate(time.exactInstant, timeZoneId, startOfDayMinute) === date
  ) {
    return time.exactInstant;
  }
  const base = civilInstant(date, time.hour, time.minute, timeZoneId);
  if (currentLogicalDate(base, timeZoneId, startOfDayMinute) === date) {
    return base;
  }
  // inside a shifted day an early wall clock belongs to the next calendar
  // day; recombine there when that assignment matches the selection
  const nextDay = civilInstant(addDays(date, 1), time.hour, time.minute, timeZoneId);
  if (currentLogicalDate(nextDay, timeZoneId, startOfDayMinute) === date) {
    return nextDay;
  }
  // a spring-forward gap can invalidate both candidates; the next valid
  // time inside the selected logical day is its start-of-day wall clock
  // (date construction normalizes forward out of a gap, staying inside)
  return civilInstant(date, Math.floor(startOfDayMinute / 60), startOfDayMinute % 60, timeZoneId);
}

export function CheckInFormScreen({ boardId, checkInId, source = 'app' }: CheckInFormScreenProps) {
  const router = useProductRouter();
  const scheme = useScheme();
  const { core, scope } = useProduct();
  const navigation = useNavigation();
  // conflicts remount the body with the reloaded record, so the notice
  // lives here where the remount cannot wipe it
  const [conflict, setConflict] = useState(false);
  const [retained, setRetained] = useState<RetainedEditor | null>(null);
  const sheetRef = useRef<BottomSheetMethods>(null);
  // the sheet closes natively before react hears about it, so the dirty
  // guard reads a ref the body keeps current instead of body state
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const skipGuardRef = useRef(false);
  const boardQuery = useProductQuery((c) => getBoard(c, boardId), [boardId]);
  const existingQuery = useProductQuery(
    (c) =>
      checkInId ? getCheckIn(c, checkInId) : Promise.resolve({ ok: true as const, value: null }),
    [checkInId],
  );
  // accepted attempts retain a locked result surface through query failures,
  // archival and resumed record changes; definitive failures release it.
  const board = retained ? { status: 'ready' as const, value: retained.board } : boardQuery;
  const existing = retained ? { status: 'ready' as const, value: retained.record } : existingQuery;

  // a pan-down or backdrop tap already dismissed the native sheet; either
  // leave the route, or reopen the sheet when unsaved edits need a decision
  const closeFromSheet = useCallback(() => {
    if (!scope.isCurrent() || !navigation.isFocused()) return;
    if (pendingRef.current) { sheetRef.current?.present(); return; }
    if (skipGuardRef.current) {
      return;
    }
    if (dirtyRef.current) {
      Alert.alert('Discard changes?', 'Your edits to this check-in are not saved.', [
        {
          text: 'Keep editing',
          style: 'cancel',
          onPress: () => sheetRef.current?.present(),
        },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            if (!scope.isCurrent() || !navigation.isFocused() || pendingRef.current) return;
            skipGuardRef.current = true;
            router.back();
          },
        },
      ]);
      return;
    }
    skipGuardRef.current = true;
    router.back();
  }, [navigation, router, scope]);

  const loadedRecord =
    checkInId && existing.status === 'ready' ? existing.value : null;

  let content;
  if (
    board.status === 'error' ||
    (checkInId && existing.status === 'error') ||
    (checkInId && existing.status === 'ready' && existing.value === null) ||
    // a record reached through a mismatched board url is not exposed
    (loadedRecord && loadedRecord.boardId !== boardId)
  ) {
    content = (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This record is not available.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else if (board.status !== 'ready' || (checkInId && existing.status !== 'ready')) {
    content = <View testID="check-in-form-loading" style={{ flex: 1 }} />;
  } else if (board.value.archivedAt !== null) {
    // an archived board is read-only: direct links to its check-in forms
    // land on an explanation instead of an editable form
    content = (
      <View
        style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}
        testID="check-in-archived-board"
      >
        <AppText variant="title2" accessibilityRole="header">
          This board is archived.
        </AppText>
        <AppText>Restore it from its board page to change its check-ins.</AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else {
    content = (
      <View style={{ flex: 1 }}>
        {conflict ? (
          <View style={{ padding: spacing.lg }}>
            <AppText testID="check-in-conflict">
              This check-in changed elsewhere. The latest values are shown - review your changes
              and save again.
            </AppText>
          </View>
        ) : null}
        <CheckInFormBody
          // an accepted attempt keeps its body through resumed query refreshes.
          // definitive failures release it so conflict reloads reseed all fields.
          key={loadedRecord?.mutationStamp ?? 'new'}
          board={board.value}
          source={source}
          record={loadedRecord}
          onConflict={() => setConflict(true)}
          retainEditor={setRetained}
          pendingRef={pendingRef}
          dirtyRef={dirtyRef}
          skipGuardRef={skipGuardRef}
          today={currentLogicalDate(
            core.clock.nowUtcMs(),
            core.clock.timeZoneId(),
            board.value.startOfDayMinute,
          )}
        />
      </View>
    );
  }

  return (
    <BottomSheet
      ref={sheetRef}
      snapPoints={['50%', '100%']}
      enablePanDownToClose
      onClose={closeFromSheet}
      backgroundStyle={{ backgroundColor: semanticColor('groupedBackground', scheme) as string }}
    >
      <BottomSheetView style={{ flex: 1 }}>{content}</BottomSheetView>
    </BottomSheet>
  );
}

type SaveAttempt =
  | { kind: 'create'; input: Parameters<typeof createCheckIn>[1] }
  | { kind: 'update'; input: Parameters<typeof updateCheckIn>[1] };

// mounted only once its data exists, so form state seeds in useState
function CheckInFormBody({
  board,
  source,
  record,
  today,
  onConflict,
  retainEditor,
  dirtyRef,
  pendingRef,
  skipGuardRef,
}: {
  board: Board;
  source: 'app' | 'widget';
  record: CheckIn | null;
  today: LogicalDate;
  onConflict: () => void;
  retainEditor: (editor: RetainedEditor | null) => void;
  dirtyRef: MutableRefObject<boolean>;
  pendingRef: MutableRefObject<boolean>;
  skipGuardRef: MutableRefObject<boolean>;
}) {
  const router = useProductRouter();
  const navigation = useNavigation();
  const scheme = useScheme();
  const { core, scope, invalidate, nextCommandId } = useProduct();
  const productZone = core.clock.timeZoneId();
  const [dirty, setDirtyState] = useState(false);
  // the parent's sheet-close guard reads the ref; react state still drives
  // the removal guard below
  const setDirty = useCallback(
    (value: boolean) => {
      setDirtyState(value);
      dirtyRef.current = value;
    },
    [dirtyRef],
  );
  const [logicalDate, setLogicalDate] = useState<LogicalDate>(record?.logicalDate ?? today);
  // time is stored as a wall-clock time of day and recombined with the
  // selected date at save, so a historical date never carries today's instant
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay | null>(() => {
    if (record && record.occurredAtUtc !== null) {
      return timeOfDayFromInstant(record.occurredAtUtc, record.timeZoneId ?? productZone);
    }
    if (record || !board.tracksTime) {
      return null;
    }
    return timeOfDayFromInstant(core.clock.nowUtcMs(), productZone);
  });
  const [timeTouched, setTimeTouched] = useState(record !== null);
  // a record edit resubmits its occurrence only when the user changed the
  // date or time; otherwise the stored instant, zone, and offset survive a
  // device zone change untouched
  const [occurrenceEdited, setOccurrenceEdited] = useState(false);
  const [amountText, setAmountText] = useState(
    record
      ? record.amount === null
        ? ''
        : String(record.amount)
      : board.tracksAmount
        ? String(board.quickAmount)
        : '',
  );
  const [note, setNote] = useState(record?.note ?? '');
  const [error, setError] = useState<DomainError | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const [completed, setCompleted] = useState(false);
  const attemptRef = useRef<SaveAttempt | null>(null);
  const busyRef = useRef(false), completedRef = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // a swipe-down or other removal of an edited form must confirm first
  usePreventRemove(scope.active && !completed && (dirty || saving || attempt !== null), ({ data }) => {
    if (!scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current) return;
    if (skipGuardRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    Alert.alert('Discard changes?', 'Your edits to this check-in are not saved.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          if (!mounted.current || !scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current) return;
          skipGuardRef.current = true;
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  const changeDate = useCallback(
    (value: Date) => {
      if (!scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current || completedRef.current) return;
      const next = logicalFromDate(value, productZone);
      setLogicalDate(next);
      setDirty(true);
      setOccurrenceEdited(true);
      // an untouched time follows the date: now for today, noon for the past
      if (!timeTouched && board.tracksTime) {
        setTimeOfDay(
          next === today
            ? timeOfDayFromInstant(core.clock.nowUtcMs(), productZone)
            : { hour: 12, minute: 0, exactInstant: null },
        );
      } else if (board.tracksTime) {
        // a chosen time survives a date change as wall clock only; the
        // exact instant belonged to the previous date
        setTimeOfDay((current) =>
          current === null ? current : { ...current, exactInstant: null },
        );
      }
    },
    [board.tracksTime, core, navigation, productZone, scope, setDirty, timeTouched, today],
  );

  const finish = useCallback(() => {
    if (!scope.isCurrent() || !navigation.isFocused() || !mounted.current) return;
    skipGuardRef.current = true;
    router.back();
  }, [navigation, router, scope, skipGuardRef]);

  const save = useCallback(async () => {
    if (!scope.isCurrent() || !navigation.isFocused() || !mounted.current || busyRef.current || completedRef.current) return;
    if (!attemptRef.current && board.tracksAmount && amountText.trim().length === 0) {
      setError({ code: 'validation', message: 'Enter an amount greater than zero.', retryable: false });
      return;
    }
    busyRef.current = true; pendingRef.current = true;
    setSaving(true); setError(null);
    const amount = board.tracksAmount ? Number(amountText.replace(',', '.')) : undefined;
    const occurredAtUtc = board.tracksTime && timeOfDay !== null && (record === null || occurrenceEdited)
      ? instantFor(logicalDate, timeOfDay, productZone, board.startOfDayMinute) : undefined;
    const current: SaveAttempt = attemptRef.current ?? (record
      ? { kind: 'update', input: { commandId: nextCommandId(), checkInId: record.id,
        expectedMutationStamp: record.mutationStamp, logicalDate, occurredAtUtc, amount, note } }
      : { kind: 'create', input: { commandId: nextCommandId(), boardId: board.id,
        logicalDate, occurredAtUtc, amount, note, source } });
    attemptRef.current = current; setAttempt(current);
    retainEditor({ board, record });
    await scope.run(async ({ core: accepted }) => {
      try {
        const result = current.kind === 'update' ? await updateCheckIn(accepted, current.input)
          : await createCheckIn(accepted, current.input);
        if (result.ok) {
          attemptRef.current = null; completedRef.current = true; pendingRef.current = false;
          if (!mounted.current) return;
          setAttempt(null); setCompleted(true); setDirty(false); invalidate(); finish();
        } else if (mounted.current) {
          setError(result.error);
          if (!result.error.retryable) {
            attemptRef.current = null; pendingRef.current = false; setAttempt(null); retainEditor(null);
          }
          if (result.error.code === 'conflict') { onConflict(); invalidate(); }
        }
      } catch {
        if (mounted.current) setError({ code: 'database', message: 'The saved result could not be confirmed. Retry to check it.', retryable: true });
      } finally {
        busyRef.current = false;
        if (mounted.current) setSaving(false);
      }
    });
  }, [amountText, board, finish, invalidate, logicalDate, navigation, nextCommandId, note, occurrenceEdited, onConflict, pendingRef, productZone, record, retainEditor, scope, setDirty, source, timeOfDay]);

  const confirmDelete = useCallback(() => {
    if (!record) {
      return;
    }
    Alert.alert('Delete Check-In', 'This permanently deletes the check-in.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Check-In',
        style: 'destructive',
        onPress: () => {
          void removeCheckIn(core, { commandId: nextCommandId(), checkInId: record.id }).then(
            (result) => {
              if (result.ok) {
                invalidate();
                skipGuardRef.current = true;
                router.back();
              } else {
                setError(result.error);
              }
            },
          );
        },
      },
    ]);
  }, [core, invalidate, nextCommandId, record, router, skipGuardRef]);

  if (attempt || completed) return <View style={{ padding: spacing.lg, gap: spacing.md }}>
    <AppText>{completed ? 'Your check-in was saved.' : saving ? 'Saving check-in...' : 'Retry to confirm this saved result before making more changes.'}</AppText>
    {error ? <InlineError message={error.message} testID="check-in-error" /> : null}
    {completed ? <PrimaryButton title="Done" onPress={finish} />
      : <PrimaryButton title="Retry" onPress={save} disabled={saving || !scope.active} testID="check-in-retry" />}
  </View>;

  const colors = deriveBoardColors(board.accentHex, scheme);
  const timeZone = record && !occurrenceEdited ? record.timeZoneId ?? productZone : productZone;
  const displayedTime = timeOfDay ?? { hour: 12, minute: 0, exactInstant: null };
  const nativeTimeZone = Platform.OS === 'android'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone;
  const timePickerValue = nativeTimeZone === timeZone
    ? new Date(displayedTime.exactInstant
      ?? instantFor(logicalDate, displayedTime, timeZone, board.startOfDayMinute))
    // a mismatched android zone is presentation-only, on a neutral date so
    // an unrelated host dst gap cannot alter the product clock face.
    : new Date(2000, 0, 15, displayedTime.hour, displayedTime.minute);

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      {/* the sheet has no navigator header, so the bar lives in content */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.lg,
        }}
      >
        <ProductPressable onPress={() => router.back()} label="Cancel" testID="check-in-cancel">
          <AppText selectable={false}>Cancel</AppText>
        </ProductPressable>
        <AppText variant="headline" accessibilityRole="header" selectable={false}>
          {record ? 'Edit Check-in' : 'Add Check-in'}
        </AppText>
        <ProductPressable onPress={save} label="Save check-in" testID="check-in-save">
          <AppText variant="headline" selectable={false}>
            Save
          </AppText>
        </ProductPressable>
      </View>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            borderRadius: radius.capsule,
            borderCurve: radiusCurve,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
          }}
          accessible
          accessibilityLabel={`Board: ${board.title}`}
        >
          <BoardSymbol symbol={board.symbol} color={colors.accent} size={18} />
          <AppText selectable={false}>{board.title}</AppText>
        </View>

        <View
          style={{
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            borderRadius: radius.lg,
            borderCurve: radiusCurve,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <AppText>Date</AppText>
            <DateTimePicker
              value={dateFromLogical(logicalDate, productZone)}
              timeZoneName={productZone}
              mode="date"
              display="compact"
              // the ceiling is the logical today: inside a shifted start of
              // day the physical date is already tomorrow's logical future
              maximumDate={dateCeiling(today, productZone)}
              accentColor={colors.accent}
              onValueChange={(_event, date) => changeDate(date)}
              style={{ width: 150, height: 36 }}
              testID="check-in-date"
            />
          </View>
          {board.tracksTime ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <AppText>Time</AppText>
              <DateTimePicker
                value={timePickerValue}
                timeZoneName={timeZone}
                mode="time"
                display="compact"
                style={{ width: 110, height: 36 }}
                accentColor={colors.accent}
                onValueChange={(_event, date) => {
                  if (!scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current || completedRef.current) return;
                  const selected = Platform.OS === 'android'
                    ? { hour: date.getHours(), minute: date.getMinutes(),
                      exactInstant: nativeTimeZone === productZone ? date.getTime() : null }
                    : timeOfDayFromInstant(date.getTime(), timeZone);
                  // an edited occurrence is captured in the current product zone;
                  // an old record's display zone supplies only its civil time.
                  if (timeZone !== productZone) selected.exactInstant = null;
                  setTimeOfDay(selected);
                  setTimeTouched(true);
                  setOccurrenceEdited(true);
                  setDirty(true);
                }}
                testID="check-in-time"
              />
            </View>
          ) : null}
          {board.tracksAmount ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <AppText>{board.amountUnit ? `Amount (${board.amountUnit})` : 'Amount'}</AppText>
              <TextInput
                accessibilityLabel="Amount"
                keyboardType="decimal-pad"
                value={amountText}
                onChangeText={(text) => {
                  if (!scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current || completedRef.current) return;
                  setAmountText(text);
                  setDirty(true);
                }}
                style={{
                  minHeight: minimumTouchTarget,
                  minWidth: 90,
                  textAlign: 'right',
                  color: semanticColor('label', scheme) as string,
                  fontSize: 17,
                }}
                testID="check-in-amount"
              />
            </View>
          ) : null}
        </View>

        <TextInput
          accessibilityLabel="Note"
          placeholder="Note…"
          placeholderTextColor={semanticColor('secondaryLabel', scheme) as string}
          value={note}
          onChangeText={(text) => {
            if (!scope.isCurrent() || !navigation.isFocused() || busyRef.current || attemptRef.current || completedRef.current) return;
            setNote(text);
            setDirty(true);
          }}
          multiline
          style={{
            minHeight: 120,
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme) as string,
            borderRadius: radius.lg,
            borderCurve: radiusCurve,
            padding: spacing.lg,
            color: semanticColor('label', scheme) as string,
            fontSize: 17,
            textAlignVertical: 'top',
          }}
          testID="check-in-note"
        />

        {error ? <InlineError message={error.message} testID="check-in-error" /> : null}

        {record ? (
          <PrimaryButton
            title="Delete Check-In"
            destructive
            onPress={confirmDelete}
            testID="delete-check-in"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
