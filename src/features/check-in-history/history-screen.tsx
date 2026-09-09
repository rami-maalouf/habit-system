import { Stack, useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { removeCheckIn } from '@/core/domain/commands';
import type { BoardId, CheckInId } from '@/core/domain/ids';
import { getBoard, getGroupedCheckInHistory } from '@/core/domain/queries';
import { semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { useProductRouter } from '../sample/navigation';
import { HistoryList } from './history-list';
import type { HistoryDaySection } from './history-list-types';

export { formatAmount, formatCheckInTime } from './history-formatters';

// logical dates carry no zone; format their utc instant in utc so labels
// never shift to a neighboring day or month on negative-offset hosts
function monthTitle(month: string, currentYear: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    ...(year === currentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function dayTitle(date: string): string {
  const [year, monthNumber, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, monthNumber - 1, day)));
}

export function CheckInHistoryScreen({ boardId }: { boardId: BoardId }) {
  const router = useProductRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const scheme = useScheme();
  const { core, scope, invalidate, nextCommandId } = useProduct();
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

  // history loads in pages so very large boards stay responsive; the page
  // grows as the reader approaches the end of the list
  const [pageLimit, setPageLimit] = useState(200);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleting = useRef(new Set<string>());
  const board = useProductQuery((c) => getBoard(c, boardId), [boardId]);
  const history = useProductQuery(
    (c) => getGroupedCheckInHistory(c, boardId, { limit: pageLimit }),
    [boardId, pageLimit],
  );
  const currentYear = Number(
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      timeZone: core.clock.timeZoneId(),
    }).format(new Date(core.clock.nowUtcMs())),
  );

  // a native swipe delete commits immediately, like the platform does
  const deleteCheckIn = useCallback(async (checkInId: string) => {
    if (!isCurrent() || deleting.current.has(checkInId)) return;
    deleting.current.add(checkInId); setDeleteError(null);
    try {
      await scope.run(async ({ core }) => {
        const result = await removeCheckIn(core, { commandId: nextCommandId(), checkInId: checkInId as CheckInId });
        invalidate();
        if (!result.ok && isCurrent()) setDeleteError(result.error.message);
      });
    } catch {
      if (isCurrent()) setDeleteError('Could not delete this check-in. Try again.');
      invalidate();
    } finally { deleting.current.delete(checkInId); }
  }, [invalidate, isCurrent, nextCommandId, scope]);

  if (board.status === 'error') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
        <AppText variant="title2" accessibilityRole="header">
          This board is not available.
        </AppText>
        <PrimaryButton title="Back to Boards" onPress={() => { if (isCurrent()) router.dismissTo('/'); }} />
      </View>
    );
  }

  const record = board.status === 'ready' ? board.value : null;
  const archived = record?.archivedAt !== null && record !== null;

  // the query reports whether older records remain; loading more becomes a
  // no-op once everything is loaded
  const hasMore = history.status === 'ready' && history.value.hasMore;
  const sections: HistoryDaySection[] =
    history.status === 'ready'
      ? history.value.months.flatMap((month) =>
          month.days.map((day, dayIndex) => ({
            title: dayTitle(day.date),
            monthHeader: dayIndex === 0 ? monthTitle(month.month, currentYear) : null,
            monthCount: month.count,
            count: day.count,
            data: day.checkIns,
          })),
        )
      : [];

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen
        options={{
          title: 'Check-Ins',
          headerRight:
            record && !archived
              ? () => (
                  <ProductPressable
                    onPress={() => { if (isCurrent()) router.push(`/boards/${boardId}/check-ins/new`); }}
                    label="Add check-in"
                    testID="add-check-in"
                  >
                    <AppText variant="title2" selectable={false}>
                      +
                    </AppText>
                  </ProductPressable>
                )
              : undefined,
        }}
      />
      {deleteError ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
          <InlineError message={deleteError} testID="history-delete-error" />
        </View>
      ) : null}
      {history.status === 'loading' ? (
        <View testID="history-loading" style={{ flex: 1 }} />
      ) : history.status === 'error' ? (
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          <InlineError message={history.error.message} testID="history-error" />
          <PrimaryButton title="Try again" onPress={() => { if (isCurrent()) history.refresh(); }} />
        </View>
      ) : sections.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
          <AppText variant="title3" accessibilityRole="header" testID="history-empty">
            No check-ins yet.
          </AppText>
          {!archived ? (
            <PrimaryButton
              title="Add Check-In"
              onPress={() => { if (isCurrent()) router.push(`/boards/${boardId}/check-ins/new`); }}
            />
          ) : null}
        </View>
      ) : (
        <HistoryList
          sections={sections}
          boardTitle={record?.title ?? 'Check-in'}
          amountUnit={record?.amountUnit ?? null}
          archived={archived}
          onOpen={(checkInId) => { if (isCurrent()) router.push(`/boards/${boardId}/check-ins/${checkInId}`); }}
          onDelete={deleteCheckIn}
          hasMore={hasMore}
          onLoadMore={() => { if (isCurrent() && hasMore) setPageLimit((current) => current + 200); }}
        />
      )}
    </View>
  );
}
