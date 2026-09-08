import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { toggleDailyCheckIn, undoCreatedCheckIn } from '@/core/domain/commands';
import type { Board } from '@/core/domain/entities';
import type { BoardId, CheckInId, CommandId } from '@/core/domain/ids';
import { getBoard, getDailyToggleSnapshot } from '@/core/domain/queries';
import type { DailyToggleSnapshot, QueryDeps } from '@/core/domain/queries';
import type { DomainResult } from '@/core/domain/result';
import { ok } from '@/core/domain/result';
import { triggerActionHaptic } from '@/foundation/haptics';
import { semanticColor, spacing } from '@/theme';

import { confirmDailyUncheck } from './confirm-daily-uncheck';
import { CheckInFormScreen } from '../check-in-history/check-in-form-screen';
import { useProduct, useProductQuery } from '../product-store';
import { InlineError, PrimaryButton, ProductPressable, RecoveryScreen, useScheme } from '../ui';

type ActionState = { board: Board; snapshot: DailyToggleSnapshot | null };
type UndoTarget = { checkInId: CheckInId; createdByCommandId: CommandId };

async function getActionState(core: QueryDeps, boardId: BoardId): Promise<DomainResult<ActionState>> {
  const board = await getBoard(core, boardId);
  if (!board.ok) return board;
  if (board.value.kind === 'count' || board.value.archivedAt !== null) return ok({ board: board.value, snapshot: null });
  const snapshot = await getDailyToggleSnapshot(core, boardId);
  return snapshot.ok ? ok({ board: board.value, snapshot: snapshot.value }) : snapshot;
}

// a stale count-widget link resolves the current kind before showing its form.
export function WidgetCheckInEntryScreen({ boardId }: { boardId: BoardId }) {
  const board = useProductQuery((core) => getBoard(core, boardId), [boardId]);
  if (board.status === 'loading') return <View testID="widget-entry-loading" />;
  if (board.status === 'error') return <RecoveryScreen message={board.error.message} />;
  if (board.value.kind === 'daily') return <Redirect href={`/boards/${boardId}/quick-action`} />;
  return <CheckInFormScreen boardId={boardId} checkInId={null} source="widget" />;
}

export function DailyWidgetActionScreen({ boardId }: { boardId: BoardId }) {
  const router = useRouter();
  const scheme = useScheme();
  const { core, invalidate, nextCommandId } = useProduct();
  const state = useProductQuery((deps) => getActionState(deps, boardId), [boardId]);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoTarget | null>(null);
  const undoRef = useRef<UndoTarget | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    undoRef.current = null;
    setUndo(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const actOnSnapshot = async (displayed: DailyToggleSnapshot) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const commandId = nextCommandId();
      const fresh = await getDailyToggleSnapshot(core, boardId);
      if (!mounted.current) return;
      if (!fresh.ok) { setError(fresh.error.message); invalidate(); return; }
      if (fresh.value.logicalDate !== displayed.logicalDate || fresh.value.checked !== displayed.checked) {
        setError('This habit changed since it was displayed. Review its current state and try again.');
        invalidate();
        return;
      }
      if (fresh.value.checked && fresh.value.noteCount > 0 && !await confirmDailyUncheck(fresh.value)) return;
      if (!mounted.current) return;
      const result = await toggleDailyCheckIn(core, {
        commandId, boardId, source: 'widget', logicalDate: fresh.value.logicalDate,
        expectedCheckIns: fresh.value.expectedCheckIns,
      });
      invalidate();
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.created && result.value.checkInId) {
        clearUndo();
        const target = { checkInId: result.value.checkInId, createdByCommandId: commandId };
        undoRef.current = target;
        setUndo(target);
        undoTimer.current = setTimeout(clearUndo, 5000);
        void triggerActionHaptic();
      } else if (!result.value.checked) {
        if (undoRef.current && result.value.removedCheckInIds.includes(undoRef.current.checkInId)) clearUndo();
        void triggerActionHaptic();
      }
    } catch {
      if (mounted.current) setError('Could not update this habit. Try again.');
      invalidate();
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const undoCreation = async () => {
    const target = undoRef.current;
    if (!target || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    clearUndo();
    setError(null);
    try {
      const result = await undoCreatedCheckIn(core, { commandId: nextCommandId(), ...target });
      invalidate();
      if (!result.ok && mounted.current) setError(result.error.message);
    } catch {
      if (mounted.current) setError('Could not undo this check-in. Try again.');
      invalidate();
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Widget check-in', headerLeft: () => (
        <ProductPressable label="Close" onPress={() => router.dismissTo('/')}>
          <Icon name="close" />
        </ProductPressable>
      ) }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        {state.status === 'loading' ? <View testID="daily-widget-loading" /> : state.status === 'error' ? (
          <>
            <InlineError message={state.error.message} testID="daily-widget-unavailable" />
            <PrimaryButton title="Try again" onPress={state.refresh} />
            <PrimaryButton title="Back to Boards" onPress={() => router.dismissTo('/')} />
          </>
        ) : (
          <>
            <AppText variant="title2" accessibilityRole="header">{state.value.board.title}</AppText>
            {state.value.board.archivedAt !== null ? (
              <>
                <AppText testID="daily-widget-archived">Restore this board before changing its check-ins.</AppText>
                <PrimaryButton title="Open board" onPress={() => router.dismissTo(`/boards/${boardId}`)} />
              </>
            ) : state.value.snapshot ? (
              <>
                <AppText variant="headline">{state.value.snapshot.checked ? 'Checked' : 'Not checked'}</AppText>
                <AppText testID="daily-widget-date">{state.value.snapshot.logicalDate}</AppText>
                <PrimaryButton title={state.value.snapshot.checked ? 'Uncheck' : 'Check'} disabled={pending}
                  onPress={() => { if (state.value.snapshot) void actOnSnapshot(state.value.snapshot); }} testID="daily-widget-action" />
              </>
            ) : (
              <>
                <AppText>This is a Count board. Add a check-in with its current settings.</AppText>
                <PrimaryButton title="Add Check-In" onPress={() => router.push(`/boards/${boardId}/check-ins/new?source=widget`)} testID="daily-widget-count-fallback" />
              </>
            )}
          </>
        )}
        {error ? <InlineError message={error} testID="daily-widget-error" /> : null}
        {undo ? <PrimaryButton title="Undo check-in" onPress={undoCreation} disabled={pending} testID="daily-widget-undo" /> : null}
      </ScrollView>
    </View>
  );
}
