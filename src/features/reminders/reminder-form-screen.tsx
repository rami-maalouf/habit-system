import {
  BottomSheet,
  BottomSheetView,
  type BottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { Board, Reminder } from '@/core/domain/entities';
import type { BoardId, ReminderId } from '@/core/domain/ids';
import type { DomainError } from '@/core/domain/result';
import { validateReminderMessage } from '@/core/domain/validation';
import { getBoard, getReminder } from '@/core/domain/queries';
import {
  createReminder,
  deleteReminder,
  updateReminder,
} from '@/core/domain/reminder-commands';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { deriveBoardColors } from '../boards';
import { draftStoreFor, useDraftState } from '../board-configuration/draft-store';
import type { DraftReminder, DraftStore } from '../board-configuration/draft-store';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { SampleDisabledScreen } from '../sample/disabled-screen';
import { useProductRouter } from '../sample/navigation';
import { useProductActivity } from '../product-store/use-product-activity';
import { WEEKDAYS, formatMinuteOfDay, isWeekdaySelected, toggleWeekday } from './weekdays';

type ReminderFormScreenProps = {
  // null targets the unsaved board draft session
  boardId: BoardId | null;
  // an existing reminder to edit, on a saved board
  reminderId: ReminderId | null;
  // an existing draft entry to edit, on an unsaved board
  draftIndex: number | null;
};

const DEFAULT_MINUTE = 9 * 60;

function minuteToDate(minute: number): Date {
  return new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60, 0, 0);
}

export function ReminderFormScreen(props: ReminderFormScreenProps) {
  const { scope } = useProduct();
  if (scope.kind === 'sample') return <SampleDisabledScreen title="Reminders" message="Reminders are unavailable in Sample mode." />;
  return <RealReminderFormScreen {...props} />;
}

type RetainedEditor = { board: Board; record: Reminder | null };

function RealReminderFormScreen({ boardId, reminderId, draftIndex }: ReminderFormScreenProps) {
  const router = useProductRouter();
  const navigation = useNavigation();
  const scheme = useScheme();
  const { core, scope } = useProduct();
  const activity = useProductActivity(scope);
  const draftStore = draftStoreFor(core);
  const draftState = useDraftState(core);
  const [origin] = useState(() => ({ store: draftStore, owner: draftState.owner }));
  const draftMode = boardId === null;
  const ownsDraft = useCallback(() => !draftMode || origin.store.owns(origin.owner, null), [draftMode, origin]);
  const sheetRef = useRef<BottomSheetMethods>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const skipGuardRef = useRef(false);
  // a conflict remounts the body with the reloaded record; the notice
  // lives here where the remount cannot wipe it
  const [conflict, setConflict] = useState(false);
  const [retained, setRetained] = useState<RetainedEditor | null>(null);

  const boardQuery = useProductQuery(
    (c) => (boardId ? getBoard(c, boardId) : Promise.resolve({ ok: true as const, value: null })),
    [boardId],
  );
  const existingQuery = useProductQuery(
    (c) =>
      reminderId ? getReminder(c, reminderId) : Promise.resolve({ ok: true as const, value: null }),
    [reminderId],
  );
  // an unresolved receipt or completed response owns this editor snapshot,
  // including a deleted row that disappears from the resumed query.
  const board = retained ? { status: 'ready' as const, value: retained.board } : boardQuery;
  const existing = retained ? { status: 'ready' as const, value: retained.record } : existingQuery;

  const closeFromSheet = useCallback(() => {
    if (!activity.active || !navigation.isFocused() || skipGuardRef.current || !ownsDraft()) {
      return;
    }
    if (pendingRef.current) { sheetRef.current?.present(); return; }
    if (dirtyRef.current) {
      Alert.alert('Discard changes?', 'Your edits to this reminder are not saved.', [
        { text: 'Keep editing', style: 'cancel', onPress: () => {
          if (activity.active && navigation.isFocused() && ownsDraft()) sheetRef.current?.present();
        } },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            if (!activity.active || !navigation.isFocused() || !ownsDraft() || pendingRef.current) return;
            skipGuardRef.current = true;
            router.back();
          },
        },
      ]);
      return;
    }
    skipGuardRef.current = true;
    router.back();
  }, [activity, navigation, ownsDraft, router]);

  const draftReminder =
    draftMode && draftIndex !== null ? (draftState.draft.reminders[draftIndex] ?? null) : null;

  let content;
  if (draftMode && (draftStore !== origin.store || !draftStore.owns(origin.owner, null))) {
    // a direct link to the draft editor without a live create session
    content = (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This reminder is not available.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else if (draftMode && draftIndex !== null && draftReminder === null) {
    content = (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This reminder is not available.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else if (!draftMode && (board.status === 'error' || (reminderId && existing.status === 'error'))) {
    content = (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This reminder is not available.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else if (
    !draftMode &&
    (board.status !== 'ready' ||
      board.value === null ||
      (reminderId !== null && existing.status !== 'ready'))
  ) {
    content = <View testID="reminder-form-loading" style={{ flex: 1 }} />;
  } else if (!draftMode && reminderId !== null && existing.status === 'ready' && existing.value === null) {
    content = (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This reminder no longer exists.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
      </View>
    );
  } else {
    const record = !draftMode && existing.status === 'ready' ? existing.value : null;
    content = (
      <View style={{ flex: 1 }}>
        {conflict ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
            <AppText testID="reminder-conflict">
              This reminder changed elsewhere. The latest values are shown - review your
              changes and save again.
            </AppText>
          </View>
        ) : null}
        <ReminderFormBody
        key={record ? record.mutationStamp : `${origin.owner}-${draftIndex ?? 'new'}`}
        board={!draftMode && board.status === 'ready' ? board.value : null}
        record={record}
        draftReminder={draftReminder}
        draftIndex={draftIndex}
        draftTitle={draftState.draft.title}
        draftStore={origin.store}
        draftOwner={origin.owner}
        dirtyRef={dirtyRef}
        pendingRef={pendingRef}
        retainEditor={setRetained}
        skipGuardRef={skipGuardRef}
          // cancel routes through the sheet-close guard so unsaved edits
          // always get the same discard confirmation
          onCancel={closeFromSheet}
          onConflict={() => setConflict(true)}
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

type ReminderAttempt =
  | { kind: 'create'; input: Parameters<typeof createReminder>[1] }
  | { kind: 'update'; input: Parameters<typeof updateReminder>[1] }
  | { kind: 'delete'; input: Parameters<typeof deleteReminder>[1] };

function ReminderFormBody({
  board,
  record,
  draftReminder,
  draftIndex,
  draftTitle,
  draftStore,
  draftOwner,
  dirtyRef,
  pendingRef,
  retainEditor,
  skipGuardRef,
  onCancel,
  onConflict,
}: {
  board: Board | null;
  record: Reminder | null;
  draftReminder: DraftReminder | null;
  draftIndex: number | null;
  draftTitle: string;
  draftStore: DraftStore;
  draftOwner: string | null;
  dirtyRef: React.MutableRefObject<boolean>;
  pendingRef: React.MutableRefObject<boolean>;
  retainEditor: (editor: RetainedEditor | null) => void;
  skipGuardRef: React.MutableRefObject<boolean>;
  onCancel: () => void;
  onConflict: () => void;
}) {
  const router = useProductRouter();
  const navigation = useNavigation();
  const scheme = useScheme();
  const { scope, invalidate, nextCommandId } = useProduct();
  const activity = useProductActivity(scope);
  const seed = record ?? draftReminder;
  const [weekdaysMask, setWeekdaysMask] = useState(seed?.weekdaysMask ?? 0b1111111);
  const [minuteOfDay, setMinuteOfDay] = useState(seed?.minuteOfDay ?? DEFAULT_MINUTE);
  const [message, setMessage] = useState(seed?.message ?? '');
  const [error, setError] = useState<DomainError | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState<ReminderAttempt | null>(null);
  const [completed, setCompleted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const attemptRef = useRef<ReminderAttempt | null>(null);
  const busyRef = useRef(false), completedRef = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => mounted.current && activity.active && navigation.isFocused()
    && (board !== null || draftStore.owns(draftOwner, null)), [activity, board, draftOwner, draftStore, navigation]);
  const canEdit = useCallback(() => current() && !busyRef.current && !attemptRef.current && !completedRef.current, [current]);

  const markDirty = useCallback(() => {
    setDirty(true);
    dirtyRef.current = true;
  }, [dirtyRef]);

  usePreventRemove(scope.active && (dirty || attempt !== null), ({ data }) => {
    if (!current() || busyRef.current || attemptRef.current) return;
    if (skipGuardRef.current) { navigation.dispatch(data.action); return; }
    Alert.alert('Discard changes?', 'Your edits to this reminder are not saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => {
        if (!canEdit()) return;
        skipGuardRef.current = true; navigation.dispatch(data.action);
      } },
    ]);
  });

  const boardTitle = board?.title ?? draftTitle;
  const colors = deriveBoardColors(board?.accentHex ?? '#78D98B', scheme);
  const editing = record !== null || draftIndex !== null;

  const finish = useCallback(() => {
    if (!current()) return;
    skipGuardRef.current = true; router.back();
  }, [current, router, skipGuardRef]);

  const complete = useCallback(() => {
    completedRef.current = true; pendingRef.current = false; dirtyRef.current = false;
    if (mounted.current) { setCompleted(true); setDirty(false); }
  }, [dirtyRef, pendingRef]);

  const runAttempt = useCallback(async (next: ReminderAttempt) => {
    if (!current() || busyRef.current || completedRef.current || board === null) return;
    busyRef.current = true; pendingRef.current = true; attemptRef.current = next;
    setSaving(true); setAttempt(next); setError(null); retainEditor({ board, record });
    await scope.run(async ({ core: accepted, effects }) => {
      try {
        if (effects.kind !== 'real') return;
        const deps = { ...accepted, scheduler: effects.reminders };
        const result = next.kind === 'delete' ? await deleteReminder(deps, next.input)
          : next.kind === 'update' ? await updateReminder(deps, next.input) : await createReminder(deps, next.input);
        if (result.ok) {
          attemptRef.current = null; complete();
          if (!mounted.current) return;
          setAttempt(null); invalidate();
          if (current() && result.value && result.value.scheduleState === 'denied') {
            Alert.alert('Notifications are off', 'The reminder is saved but disabled. Allow notifications in Settings to turn it on.');
          }
          finish();
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
  }, [board, complete, current, finish, invalidate, onConflict, pendingRef, record, retainEditor, scope]);

  const save = useCallback(async () => {
    if (!canEdit()) return;
    if (weekdaysMask === 0) {
      setError({ code: 'validation', message: 'Pick at least one weekday.', retryable: false });
      return;
    }
    const validatedMessage = validateReminderMessage(message);
    if (!validatedMessage.ok) {
      setError(validatedMessage.error);
      return;
    }
    setError(null);
    // an unsaved board keeps its reminders in the draft; they commit
    // together with the board only after both validate
    if (board === null) {
      if (!draftStore.owns(draftOwner, null)) return;
      const entry: DraftReminder = {
        weekdaysMask,
        minuteOfDay,
        message: validatedMessage.value ?? '',
        enabled: draftReminder?.enabled ?? true,
      };
      const reminders = [...draftStore.getSnapshot().draft.reminders];
      if (draftIndex !== null) {
        if (!reminders[draftIndex]) return;
        reminders[draftIndex] = entry;
      } else {
        reminders.push(entry);
      }
      if (!draftStore.update(draftOwner, { reminders })) return;
      complete(); finish();
      return;
    }
    await runAttempt(record
      ? { kind: 'update', input: {
          commandId: nextCommandId(),
          reminderId: record.id,
          expectedMutationStamp: record.mutationStamp,
          weekdaysMask,
          minuteOfDay,
          message: message.trim().length > 0 ? message : null,
        } }
      : { kind: 'create', input: {
          commandId: nextCommandId(),
          boardId: board.id,
          weekdaysMask,
          minuteOfDay,
          message: message.trim().length > 0 ? message : null,
          enabled: true,
        } });
  }, [board, canEdit, complete, draftIndex, draftOwner, draftReminder, draftStore, finish, message, minuteOfDay, nextCommandId, record, runAttempt, weekdaysMask]);

  const confirmDelete = useCallback(() => {
    if (!canEdit()) return;
    Alert.alert('Delete Reminder', 'This removes the reminder and its notifications.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Reminder',
        style: 'destructive',
        onPress: () => {
          if (!canEdit()) return;
          if (record) {
            void runAttempt({ kind: 'delete', input: { commandId: nextCommandId(), reminderId: record.id } });
            return;
          }
          if (draftIndex !== null) {
            if (!draftStore.owns(draftOwner, null) || !draftStore.getSnapshot().draft.reminders[draftIndex]) return;
            const reminders = draftStore.getSnapshot().draft.reminders.filter(
              (_, index) => index !== draftIndex,
            );
            if (!draftStore.update(draftOwner, { reminders })) return;
            complete(); finish();
          }
        },
      },
    ]);
  }, [canEdit, complete, draftIndex, draftOwner, draftStore, finish, nextCommandId, record, runAttempt]);

  if (attempt || completed) return <View style={{ padding: spacing.lg, gap: spacing.md }}>
    <AppText>{completed ? 'Your reminder change was saved.' : saving ? 'Saving reminder...' : 'Retry to confirm this saved result before making more changes.'}</AppText>
    {error ? <InlineError message={error.message} testID="reminder-error" /> : null}
    {completed ? <PrimaryButton title="Done" onPress={finish} />
      : <PrimaryButton title="Retry" onPress={() => { if (attemptRef.current) void runAttempt(attemptRef.current); }} disabled={saving || !scope.active} />}
  </View>;

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.lg,
        }}
      >
        <ProductPressable onPress={onCancel} label="Cancel" testID="reminder-cancel">
          <AppText selectable={false}>Cancel</AppText>
        </ProductPressable>
        <AppText variant="headline" accessibilityRole="header" selectable={false}>
          {editing ? 'Edit Reminder' : 'Add Reminder'}
        </AppText>
        <ProductPressable onPress={() => void save()} label="Save reminder" testID="reminder-save">
          <AppText variant="headline" selectable={false}>
            {editing ? 'Save' : 'Add'}
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
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            borderRadius: radius.lg,
            borderCurve: radiusCurve,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {WEEKDAYS.map((weekday) => {
              const selected = isWeekdaySelected(weekdaysMask, weekday.iso);
              return (
                <ProductPressable
                  key={weekday.iso}
                  onPress={() => {
                    if (!canEdit()) return;
                    setWeekdaysMask((mask) => toggleWeekday(mask, weekday.iso));
                    markDirty();
                  }}
                  label={weekday.name}
                  selected={selected}
                  testID={`weekday-${weekday.iso}`}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: selected
                        ? colors.accent
                        : (semanticColor('fill', scheme) as string),
                    }}
                  >
                    <AppText selectable={false}>{weekday.short}</AppText>
                  </View>
                </ProductPressable>
              );
            })}
          </View>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <AppText>Time</AppText>
            <DateTimePicker
              value={minuteToDate(minuteOfDay)}
              mode="time"
              display="compact"
              style={{ width: 110, height: 36 }}
              accentColor={colors.accent}
              onValueChange={(_event, date) => {
                if (!canEdit()) return;
                setMinuteOfDay(date.getHours() * 60 + date.getMinutes());
                markDirty();
              }}
              testID="reminder-time"
            />
          </View>
        </View>

        <TextInput
          accessibilityLabel="Reminder message"
          placeholder={boardTitle.length > 0 ? `Check in to ${boardTitle}` : 'Message…'}
          placeholderTextColor={semanticColor('secondaryLabel', scheme) as string}
          value={message}
          onChangeText={(text) => {
            if (!canEdit()) return;
            setMessage(text);
            markDirty();
          }}
          style={{
            minHeight: minimumTouchTarget,
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme) as string,
            borderRadius: radius.lg,
            borderCurve: radiusCurve,
            padding: spacing.lg,
            color: semanticColor('label', scheme) as string,
            fontSize: 17,
          }}
          testID="reminder-message"
        />

        <AppText variant="footnote">
          {`Repeats ${formatMinuteOfDay(minuteOfDay)} on the selected days.`}
        </AppText>

        {error ? <InlineError message={error.message} testID="reminder-error" /> : null}

        {editing ? (
          <PrimaryButton
            title="Delete Reminder"
            destructive
            onPress={confirmDelete}
            testID="delete-reminder"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
