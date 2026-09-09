import { Stack, useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import {
  deleteBoard,
  restoreBoard,
  updateBoard,
} from '@/core/domain/commands';
import type { Board } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';
import {
  getBoard,
  getBoardDependentCounts,
  getBoardHeatmap,
  getBoardSummary,
} from '@/core/domain/queries';
import { radius, radiusCurve, semanticColor, semanticFallbacks, spacing } from '@/theme';

import { deriveBoardColors } from './board-colors';
import { HeatmapView } from './heatmap-view';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { useProductRouter } from '../sample/navigation';
import { HabitProgress } from '../analytics';

export function BoardDetailScreen({ boardId }: { boardId: BoardId }) {
  const router = useProductRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  const { scope, invalidate, nextCommandId } = useProduct();
  // callbacks retain the focus owner and product generation that created them.
  const activeScene = useRef<object | null>(null);
  const scene = useMemo(() => ({}), [scope, focused, boardId]);
  useEffect(() => {
    activeScene.current = scene;
    return () => { if (activeScene.current === scene) activeScene.current = null; };
  }, [scene]);
  const isCurrent = useCallback(
    () => activeScene.current === scene && scope.isCurrent() && focused && navigation.isFocused(),
    [scene, scope, focused, navigation],
  );

  const board = useProductQuery((c) => getBoard(c, boardId), [boardId]);
  const summary = useProductQuery((c) => getBoardSummary(c, boardId), [boardId]);
  const heatmap = useProductQuery((c) => getBoardHeatmap(c, boardId), [boardId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scrollHeaderReady, setScrollHeaderReady] = useState(false);
  const resetScrollHeader = useCallback((view: ScrollView | null) => {
    if (view === null) setScrollHeaderReady(false);
  }, []);

  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const cancelConfirmation = useRef<(() => void) | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { cancelConfirmation.current?.(); }, [scene]);

  const changeBoard = useCallback(async (action: { kind: 'restore' } | { kind: 'metrics'; record: Board }) => {
    if (!isCurrent() || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setActionError(null);
    try {
      await scope.run(async ({ core }) => {
        const result = action.kind === 'restore'
          ? await restoreBoard(core, { commandId: nextCommandId(), boardId })
          : await updateBoard(core, {
            commandId: nextCommandId(), boardId, expectedMutationStamp: action.record.mutationStamp,
            title: action.record.title, symbol: action.record.symbol, accentHex: action.record.accentHex,
            usesTintedBackground: action.record.usesTintedBackground, tracksAmount: action.record.tracksAmount,
            tracksTime: action.record.tracksTime, startOfDayMinute: action.record.startOfDayMinute, metricsEnabled: true,
          });
        invalidate();
        if (!result.ok && isCurrent()) setActionError(result.error.message);
      });
    } catch {
      if (isCurrent()) setActionError('Could not update this board. Try again.');
      invalidate();
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }, [boardId, invalidate, isCurrent, nextCommandId, scope]);

  const confirmDelete = useCallback(async () => {
    if (!isCurrent() || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setActionError(null);
    try {
      const preview = await scope.run(({ core }) => getBoardDependentCounts(core, boardId));
      if (!isCurrent() || !preview.started) return;
      const counts = preview.value;
      const summaryText = counts.ok
        ? `This permanently deletes ${counts.value.checkIns} check-ins, ${counts.value.notes} notes, and ${counts.value.reminders} reminders.`
        : 'This permanently deletes the board and everything it contains.';
      const anchoredBoards = counts.ok ? counts.value.anchoredBoards : null;
      const anchorSummary = anchoredBoards === null
        ? 'Habits anchored to this board will lose that anchor. Those habits and their history remain.'
        : anchoredBoards === 0 ? ''
          : `This also removes the anchor from ${anchoredBoards} habit${anchoredBoards === 1 ? '' : 's'}. ${anchoredBoards === 1 ? 'That habit and its history remain.' : 'Those habits and their history remain.'}`;
      const confirmed = await new Promise<boolean>(resolve => {
        const cancel = () => decide(false);
        const decide = (value: boolean) => {
          if (cancelConfirmation.current !== cancel) return;
          cancelConfirmation.current = null; resolve(value);
        };
        cancelConfirmation.current = cancel;
        Alert.alert('Delete Board', [summaryText, anchorSummary].filter(Boolean).join('\n\n'), [
          { text: 'Cancel', style: 'cancel', onPress: cancel },
          { text: 'Delete Board', style: 'destructive', onPress: () => decide(true) },
        ]);
      });
      if (!confirmed || !isCurrent()) return;
      await scope.run(async ({ core }) => {
        const result = await deleteBoard(core, { commandId: nextCommandId(), boardId });
        invalidate();
        if (!isCurrent()) return;
        if (result.ok) router.dismissTo('/');
        else setActionError(result.error.message);
      });
    } catch {
      if (isCurrent()) setActionError('Could not delete this board. Try again.');
      invalidate();
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }, [boardId, invalidate, isCurrent, nextCommandId, router, scope]);

  if (board.status === 'loading') {
    return <View testID="board-loading" style={{ flex: 1 }} />;
  }

  if (board.status === 'error') {
    // covers missing and deleted boards with a recovery path home
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <Stack.Screen options={{ title: 'Board unavailable' }} />
        <AppText variant="title2" accessibilityRole="header">
          This board is not available.
        </AppText>
        <AppText>{board.error.message}</AppText>
        <PrimaryButton title="Back to Boards" onPress={() => { if (isCurrent()) router.dismissTo('/'); }} testID="board-recovery-home" />
      </View>
    );
  }

  const record = board.value;
  const colors = deriveBoardColors(record.accentHex, scheme);
  const archived = record.archivedAt !== null;
  const supportError =
    summary.status === 'error'
      ? summary.error
      : heatmap.status === 'error'
        ? heatmap.error
        : null;

  // keep the scroll view in the first native descendant chain for ios edge effects.
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen
        options={{
          title: record.title,
          // native layout must finish before navigation can find the scroll view.
          scrollEdgeEffects: { top: scrollHeaderReady ? 'soft' : 'automatic' },
          headerRight: archived
            ? undefined
            : () => (
                <ProductPressable
                  onPress={() => { if (isCurrent()) router.push(`/boards/${record.id}/edit`); }}
                  label="Edit board"
                  testID="edit-board"
                >
                  <Icon name="pencil" size={22} color={semanticFallbacks.label[scheme]} />
                </ProductPressable>
              ),
        }}
      />
      <ScrollView
        ref={resetScrollHeader}
        onLayout={() => setScrollHeaderReady(true)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        {archived ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="archived-banner"
          >
            <AppText variant="headline">This board is archived.</AppText>
            <AppText variant="subheadline">
              It is read-only until you restore it. Its history stays safe.
            </AppText>
            <PrimaryButton
              title="Restore Board"
              testID="restore-board"
              disabled={pending}
              onPress={() => { void changeBoard({ kind: 'restore' }); }}
            />
            <PrimaryButton title="Delete Board" destructive disabled={pending} onPress={confirmDelete} testID="delete-board" />
          </View>
        ) : null}

        {supportError ? (
          <View style={{ gap: spacing.md }} testID="detail-query-error">
            <InlineError message={supportError.message} />
            <PrimaryButton
              title="Try again"
              onPress={() => { if (isCurrent()) invalidate(); }}
              testID="detail-query-retry"
            />
          </View>
        ) : null}

        {heatmap.status === 'ready' && heatmap.value ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
            }}
          >
            <HeatmapView kind={record.kind} weeks={heatmap.value.weeks} colors={colors} testID="board-heatmap" />
          </View>
        ) : null}

        {!record.metricsEnabled && !archived ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="metrics-disabled"
          >
            <AppText>Performance metrics are off for this board.</AppText>
            <PrimaryButton
              title="Enable Metrics"
              testID="enable-metrics"
              disabled={pending}
              onPress={() => { void changeBoard({ kind: 'metrics', record }); }}
            />
          </View>
        ) : null}

        {record.metricsEnabled && summary.status === 'ready' && summary.value ? (
          <HabitProgress
            summary={summary.value}
            weeks={heatmap.status === 'ready' ? heatmap.value?.weeks : undefined}
            colors={colors}
          />
        ) : null}

        {actionError ? <InlineError message={actionError} testID="board-action-error" /> : null}
      </ScrollView>

      {!archived ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            paddingBottom: Math.max(insets.bottom, spacing.md),
            gap: spacing.md,
          }}
          testID="board-actions"
        >
          <View
            style={{
              flexDirection: 'row',
              gap: spacing.sm,
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.capsule,
              borderCurve: radiusCurve,
              paddingHorizontal: spacing.sm,
              paddingVertical: 4,
            }}
          >
            <ProductPressable
              onPress={record.metricsEnabled ? () => { if (isCurrent()) router.push(`/boards/${record.id}/analytics`); } : undefined}
              disabled={!record.metricsEnabled}
              label="Analytics"
              testID="open-analytics"
            >
              <Icon name="analytics" size={23} color={semanticFallbacks.label[scheme]} />
            </ProductPressable>
            <ProductPressable
              onPress={() => { if (isCurrent()) router.push(`/boards/${record.id}/check-ins`); }}
              label="Check-Ins"
              testID="open-check-ins"
            >
              <Icon name="checkIns" size={23} color={semanticFallbacks.label[scheme]} />
            </ProductPressable>
            <ProductPressable
              onPress={() => { if (isCurrent()) router.push(`/boards/${record.id}/journal`); }}
              label="Journal"
              testID="open-journal"
            >
              <Icon name="journal" size={23} color={semanticFallbacks.label[scheme]} />
            </ProductPressable>
          </View>
          <ProductPressable
            // the reference opens the add check-in sheet: date defaults to
            // today and any past date is selectable there
            onPress={() => { if (isCurrent()) router.push(`/boards/${record.id}/check-ins/new`); }}
            label="Add check-in"
            hint="Opens the add check-in sheet"
            testID="detail-add-check-in"
          >
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: radius.capsule,
                borderCurve: radiusCurve,
                backgroundColor: colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="add" size={27} color={colors.onAccent} />
            </View>
          </ProductPressable>
        </View>
      ) : null}
    </View>
  );
}
