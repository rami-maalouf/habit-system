import { Stack, useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { listArchivedBoards } from '@/core/domain/queries';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { BoardSymbol, deriveBoardColors } from '../boards';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { useProductRouter } from '../sample/navigation';

export function ArchivedBoardsScreen() {
  const router = useProductRouter();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const scheme = useScheme();
  const { scope } = useProduct();
  // callbacks retain the focus owner and product generation that created them.
  const activeScene = useRef<object | null>(null);
  const scene = useMemo(() => ({}), [scope, focused]);
  useEffect(() => {
    activeScene.current = scene;
    return () => { if (activeScene.current === scene) activeScene.current = null; };
  }, [scene]);
  const isCurrent = useCallback(
    () => activeScene.current === scene && scope.isCurrent() && focused && navigation.isFocused(),
    [scene, scope, focused, navigation],
  );

  const archived = useProductQuery((c) => listArchivedBoards(c), []);

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Archived Boards' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
      >
        {archived.status === 'loading' ? (
          <View testID="archived-loading" />
        ) : archived.status === 'error' ? (
          <View style={{ gap: spacing.md }}>
            <InlineError message={archived.error.message} testID="archived-error" />
            <PrimaryButton title="Try again" onPress={() => { if (isCurrent()) archived.refresh(); }} testID="archived-retry" />
          </View>
        ) : archived.value.length === 0 ? (
          <AppText variant="subheadline" testID="archived-empty">
            Boards you archive appear here. Their history stays safe.
          </AppText>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {archived.value.map((board) => {
              const colors = deriveBoardColors(board.accentHex, scheme);
              return (
                <ProductPressable
                  key={board.id}
                  onPress={() => { if (isCurrent()) router.push(`/boards/${board.id}`); }}
                  label={`${board.title}, archived board`}
                  hint="Opens the archived board to restore or delete it"
                  stretch
                  testID={`archived-board-${board.id}`}
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
                  >
                    <BoardSymbol symbol={board.symbol} color={colors.accent} size={18} />
                    <AppText numberOfLines={1} style={{ flexShrink: 1 }} selectable={false}>
                      {board.title}
                    </AppText>
                    <View style={{ flex: 1 }} />
                    <AppText selectable={false}>›</AppText>
                  </View>
                </ProductPressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
