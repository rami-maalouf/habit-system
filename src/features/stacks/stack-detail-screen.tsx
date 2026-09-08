import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { BoardId } from '@/core/domain/ids';
import { getStackDetailSnapshot } from '@/core/domain/stack-queries';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { StackHeatmap } from './stack-heatmap';
import { StackOverview } from './stack-overview';
import { useStackSnapshot } from './use-stack-snapshot';

export function StackDetailScreen({ rootId }: { rootId: BoardId }) {
  const router = useRouter();
  const scheme = useScheme();
  const snapshot = useStackSnapshot((core) => getStackDetailSnapshot(core, rootId), rootId);
  const [scrollReady, setScrollReady] = useState(false);
  const stack = snapshot.status === 'ready' && snapshot.value.stack.rootId === rootId ? snapshot.value.stack : null;
  const card = { backgroundColor: semanticColor('secondaryGroupedBackground', scheme), borderRadius: radius.lg, borderCurve: radiusCurve, padding: spacing.lg, gap: spacing.lg };
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Stack', scrollEdgeEffects: { top: scrollReady ? 'soft' : 'automatic' } }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" onLayout={() => setScrollReady(true)} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {snapshot.status === 'error' ? (
          <View style={{ gap: spacing.md }}>
            <InlineError message={snapshot.error.message} testID="stack-error" />
            <PrimaryButton title="Try again" testID="stack-retry" onPress={snapshot.refresh} />
            <PrimaryButton title="Back to Stacks" onPress={() => router.dismissTo('/stacks')} />
          </View>
        ) : stack === null ? <AppText testID="stack-loading">Loading stack...</AppText> : (
          <View testID="stack-detail" style={{ gap: spacing.lg }}>
            <View style={card}><StackOverview stack={stack} weeklyCounts={stack.memberWeeklyCounts} /></View>
            <View style={card}>
              <AppText variant="headline" accessibilityRole="header">Past 365 days</AppText>
              <StackHeatmap cells={stack.heatmap} />
            </View>
            <View style={card} testID="stack-longest-streak">
              <AppText variant="headline">Longest streak</AppText>
              <AppText variant="title1" style={{ fontVariant: ['tabular-nums'] }}>{`${stack.longestStreak} ${stack.longestStreak === 1 ? 'day' : 'days'}`}</AppText>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
