import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { createCheckIn, reorderBoard, toggleDailyCheckIn, undoCreatedCheckIn } from '@/core/domain/commands';
import type { BoardId, CheckInId, CommandId } from '@/core/domain/ids';
import type { HomeBoardCard } from '@/core/domain/queries';
import { getDailyToggleSnapshot, getHomeBoardProjection } from '@/core/domain/queries';
import { triggerActionHaptic } from '@/foundation/haptics';
import { semanticColor, semanticFallbacks, spacing } from '@/theme';

import { BoardCard } from './board-card';
import { confirmDailyUncheck } from './confirm-daily-uncheck';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { CoinBalancePill } from '../coins/coin-balance-pill';

type UndoState = {
  boardId: BoardId;
  boardTitle: string;
  checkInId: CheckInId;
  createdByCommandId: CommandId;
};

const UNDO_WINDOW_MS = 5000;

export function BoardsHomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  const { core, invalidate, nextCommandId } = useProduct();
  const boards = useProductQuery((c) => getHomeBoardProjection(c), []);
  const [editMode, setEditMode] = useState(false);
  // pending is a set: concurrent quick check-ins on different boards must
  // not re-enable or clear each other
  const [pendingBoardIds, setPendingBoardIds] = useState<ReadonlySet<BoardId>>(new Set());
  const pendingBoards = useRef(new Set<BoardId>());
  const [quickError, setQuickError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTarget = useRef<UndoState | null>(null);
  const undoPending = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollHeaderReady, setScrollHeaderReady] = useState(false);
  const resetScrollHeader = useCallback((view: FlatList<HomeBoardCard> | null) => {
    if (view === null) setScrollHeaderReady(false);
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimer.current) {
        clearTimeout(undoTimer.current);
      }
    };
  }, []);

  const clearUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    undoTarget.current = null;
    setUndo(null);
  }, []);

  const offerUndo = useCallback((target: UndoState) => {
    clearUndo();
    undoTarget.current = target;
    setUndo(target);
    undoTimer.current = setTimeout(clearUndo, UNDO_WINDOW_MS);
  }, [clearUndo]);

  const releaseBoard = useCallback((boardId: BoardId) => {
    pendingBoards.current.delete(boardId);
    setPendingBoardIds(new Set(pendingBoards.current));
  }, []);

  const quickCheckIn = useCallback(async (card: HomeBoardCard) => {
    const boardId = card.board.id;
    // claim before the first await; rendered disabled state cannot guard queued taps.
    if (pendingBoards.current.has(boardId)) return;
    pendingBoards.current.add(boardId);
    setPendingBoardIds(new Set(pendingBoards.current));
    setQuickError(null);
    try {
      const commandId = nextCommandId();
      if (card.daily) {
        const snapshot = await getDailyToggleSnapshot(core, boardId);
        if (!snapshot.ok) {
          setQuickError(snapshot.error.message);
          invalidate();
          return;
        }
        if (snapshot.value.logicalDate !== card.today || snapshot.value.checked !== card.daily.checkedToday) {
          setQuickError('This habit changed since it was displayed. Review its current state and try again.');
          invalidate();
          return;
        }
        if (snapshot.value.checked && snapshot.value.noteCount > 0 && !await confirmDailyUncheck(snapshot.value)) return;
        const result = await toggleDailyCheckIn(core, {
          commandId, boardId, logicalDate: snapshot.value.logicalDate,
          expectedCheckIns: snapshot.value.expectedCheckIns,
        });
        if (!result.ok) {
          setQuickError(result.error.message);
          invalidate();
          return;
        }
        invalidate();
        if (result.value.created && result.value.checkInId) {
          void triggerActionHaptic();
          offerUndo({ boardId, boardTitle: snapshot.value.boardTitle, checkInId: result.value.checkInId, createdByCommandId: commandId });
        } else if (!result.value.checked) {
          void triggerActionHaptic();
          if (undoTarget.current && result.value.removedCheckInIds.includes(undoTarget.current.checkInId)) clearUndo();
        }
      } else {
        const result = await createCheckIn(core, { commandId, boardId, source: 'app' });
        if (!result.ok) {
          setQuickError(result.error.message);
          invalidate();
          return;
        }
        invalidate();
        if (result.value.created) {
          void triggerActionHaptic();
          offerUndo({ boardId, boardTitle: card.board.title, checkInId: result.value.checkInId, createdByCommandId: commandId });
        }
      }
    } catch {
      setQuickError('Could not update this habit. Try again.');
      invalidate();
    } finally {
      releaseBoard(boardId);
    }
  }, [clearUndo, core, invalidate, nextCommandId, offerUndo, releaseBoard]);

  const undoLast = useCallback(async () => {
    const target = undoTarget.current;
    if (!target || undoPending.current || pendingBoards.current.has(target.boardId)) return;
    undoPending.current = true;
    pendingBoards.current.add(target.boardId);
    setPendingBoardIds(new Set(pendingBoards.current));
    clearUndo();
    setQuickError(null);
    try {
      const result = await undoCreatedCheckIn(core, {
        commandId: nextCommandId(), checkInId: target.checkInId,
        createdByCommandId: target.createdByCommandId,
      });
      invalidate();
      if (!result.ok) setQuickError(result.error.message);
    } catch {
      setQuickError('Could not undo this check-in. Try again.');
      invalidate();
    } finally {
      undoPending.current = false;
      releaseBoard(target.boardId);
    }
  }, [clearUndo, core, invalidate, nextCommandId, releaseBoard]);

  const move = useCallback(
    async (cards: HomeBoardCard[], index: number, direction: -1 | 1) => {
      const target = cards[index + direction];
      if (!target) {
        return;
      }
      // moving up places the board before its previous neighbor
      const newIndex = index + direction;
      const previous = direction === -1 ? cards[newIndex - 1] : cards[newIndex];
      const next = direction === -1 ? cards[newIndex] : cards[newIndex + 1];
      const result = await reorderBoard(core, {
        commandId: nextCommandId(),
        boardId: cards[index].board.id,
        previousBoardId: previous ? previous.board.id : null,
        nextBoardId: next ? next.board.id : null,
      });
      if (result.ok) {
        invalidate();
      } else {
        // a neighbor may have vanished concurrently; say so instead of a
        // silently dead control
        setQuickError(result.error.message);
      }
    },
    [core, invalidate, nextCommandId],
  );

  // keep the scroll view in the first native descendant chain for ios edge effects.
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen
        options={{
          title: 'Boards',
          // native layout must finish before navigation can find the scroll view.
          scrollEdgeEffects: { top: scrollHeaderReady ? 'soft' : 'automatic' },
          headerLeft: () => (
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <ProductPressable
                onPress={() => router.push('/settings')}
                label="Settings"
                hint="Opens settings"
                testID="open-settings"
              >
                <Icon name="settings" size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
              <ProductPressable onPress={() => router.push('/stacks')} label="Stacks" hint="Opens habit stacks" testID="open-stacks">
                <Icon name="stacks" size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
            </View>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: spacing.xs }}>
              <CoinBalancePill />
              <ProductPressable
                onPress={() => setEditMode((current) => !current)}
                label={editMode ? 'Done editing boards' : 'Edit boards'}
                selected={editMode}
                testID="toggle-edit-boards"
              >
                <Icon name={editMode ? 'checkmark' : 'pencil'} size={22} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
              <ProductPressable
                onPress={() => router.push('/boards/new')}
                label="Create board"
                testID="create-board"
              >
                <Icon name="add" size={28} color={semanticFallbacks.label[scheme]} />
              </ProductPressable>
            </View>
          ),
        }}
      />
      {boards.status === 'loading' ? (
        <View testID="boards-loading" style={{ flex: 1 }} />
      ) : boards.status === 'error' ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
          <InlineError message={boards.error.message} testID="boards-error" />
          <PrimaryButton title="Try again" onPress={boards.refresh} />
        </ScrollView>
      ) : boards.value.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
          <AppText variant="title2" accessibilityRole="header">
            Boards turn habits into something you can see.
          </AppText>
          <PrimaryButton
            title="Create Board"
            onPress={() => router.push('/boards/new')}
            testID="empty-create-board"
          />
        </View>
      ) : (
        <FlatList
          ref={resetScrollHeader}
          onLayout={() => setScrollHeaderReady(true)}
          data={boards.value}
          keyExtractor={(card) => card.board.id}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
          renderItem={({ item, index }) => (
            <BoardCard
              card={item}
              testID={`board-card-${index}`}
              onOpen={() => router.push(`/boards/${item.board.id}`)}
              onQuickCheckIn={() => quickCheckIn(item)}
              quickPending={pendingBoardIds.has(item.board.id)}
              editMode={editMode}
              canMoveUp={index > 0}
              canMoveDown={index < boards.value.length - 1}
              onMoveUp={() => move(boards.value, index, -1)}
              onMoveDown={() => move(boards.value, index, 1)}
            />
          )}
        />
      )}
      {quickError ? (
        <View style={{ padding: spacing.lg }}>
          <InlineError message={quickError} testID="quick-error" />
        </View>
      ) : null}
      {undo ? (
        <View
          style={{
            padding: spacing.lg,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
          }}
        >
          <AppText variant="subheadline" style={{ flex: 1, minWidth: 0 }}>{`Checked in to ${undo.boardTitle}`}</AppText>
          <ProductPressable onPress={undoLast} disabled={pendingBoardIds.has(undo.boardId)} label="Undo check-in" testID="undo-check-in">
            <AppText variant="headline" selectable={false}>
              Undo
            </AppText>
          </ProductPressable>
        </View>
      ) : null}
    </View>
  );
}
