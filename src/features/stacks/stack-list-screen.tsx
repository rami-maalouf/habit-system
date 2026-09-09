import { Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { getStackListSnapshot } from '@/core/domain/stack-queries';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { useProductRouter } from '../sample/navigation';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { stackLabel, StackOverview } from './stack-overview';
import { useStackSnapshot } from './use-stack-snapshot';

export function StackListScreen() {
  const router = useProductRouter();
  const scheme = useScheme();
  const snapshot = useStackSnapshot(getStackListSnapshot, 'list');
  const [scrollReady, setScrollReady] = useState(false);
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Stacks', scrollEdgeEffects: { top: scrollReady ? 'soft' : 'automatic' } }} />
      <FlatList
        testID="stacks-list"
        data={snapshot.status === 'ready' ? snapshot.value.stacks : []}
        keyExtractor={(stack) => stack.rootId}
        contentInsetAdjustmentBehavior="automatic"
        onLayout={() => setScrollReady(true)}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
        ListEmptyComponent={snapshot.status === 'loading' ? (
          <AppText testID="stacks-loading">Loading stacks...</AppText>
        ) : snapshot.status === 'error' ? (
          <View style={{ gap: spacing.md }}>
            <InlineError message={snapshot.error.message} testID="stacks-error" />
            <PrimaryButton title="Try again" onPress={snapshot.refresh} testID="stacks-retry" />
          </View>
        ) : (
          <View testID="stacks-empty" style={{ gap: spacing.lg, paddingVertical: spacing.xl }}>
            <AppText variant="title2" accessibilityRole="header">Build on what you already do.</AppText>
            <AppText>Anchor a habit to another habit, a preset, or an event to build a stack.</AppText>
            <PrimaryButton title="Create Board" testID="stacks-create-board" onPress={() => router.push('/boards/new')} />
          </View>
        )}
        renderItem={({ item }) => (
          <ProductPressable
            label={stackLabel(item)}
            hint="Opens stack history"
            stretch
            testID={`stack-card-${item.rootId}`}
            onPress={() => router.push(`/stacks/${item.rootId}`)}
            style={{ padding: spacing.lg, gap: spacing.md, backgroundColor: semanticColor('secondaryGroupedBackground', scheme), borderRadius: radius.lg, borderCurve: radiusCurve }}
          >
            <StackOverview stack={item} />
          </ProductPressable>
        )}
      />
    </View>
  );
}
