import { Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, useWindowDimensions, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { CoinHistoryItem } from '@/core/domain/coin-queries';
import { brand, radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { coinDateLabel, coinHistoryPresentation } from './history-presentation';
import { useCoinHistory } from './use-coin-history';

export function CoinHistoryScreen() {
  const scheme = useScheme();
  const { fontScale } = useWindowDimensions();
  const history = useCoinHistory();
  const [scrollReady, setScrollReady] = useState(false);
  const sections = useMemo(() => {
    const dates = new Map<string, CoinHistoryItem[]>();
    for (const item of history.items) {
      const rows = dates.get(item.logicalDate) ?? [];
      rows.push(item); dates.set(item.logicalDate, rows);
    }
    return [...dates].map(([date, data]) => ({ key: date, date, data }));
  }, [history.items]);
  const firstError = history.error ? <View style={{ paddingVertical: spacing.md, gap: spacing.md }}>
    <InlineError testID="coin-history-error" message={history.error.message} />
    <PrimaryButton title="Try again" testID="coin-history-retry" onPress={history.refresh} />
  </View> : null;
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Coin History', scrollEdgeEffects: { top: scrollReady ? 'soft' : 'automatic' } }} />
      <SectionList
        testID="coin-history-list" sections={sections} keyExtractor={item => item.id}
        contentInsetAdjustmentBehavior="automatic" onLayout={() => setScrollReady(true)}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 }}
        onEndReached={history.loadMore} onEndReachedThreshold={0.5}
        onRefresh={history.refresh} refreshing={history.status === 'loading' && history.items.length > 0}
        ListHeaderComponent={history.items.length > 0 ? firstError : null}
        ListEmptyComponent={history.status === 'loading' ? <AppText testID="coin-history-loading" style={{ paddingVertical: spacing.lg }}>Loading history...</AppText>
          : firstError ?? <View testID="coin-history-empty" style={{ paddingVertical: spacing.xl, gap: spacing.sm }}>
            <AppText variant="title2">Your coin activity will appear here.</AppText>
            <AppText>Earn coins by checking habits with Earn Coins enabled or completing a stack.</AppText>
          </View>}
        renderSectionHeader={({ section }) => <AppText variant="headline" accessibilityRole="header" testID={`coin-history-date-${section.date}`}
          style={{ paddingVertical: spacing.md, backgroundColor: semanticColor('groupedBackground', scheme) }}>{coinDateLabel(section.date)}</AppText>}
        renderItem={({ item }) => {
          const text = coinHistoryPresentation(item);
          const verticalHeading = fontScale > 1.3 || text.delta.length > 8;
          return <View accessible accessibilityLabel={text.label} testID={`coin-history-row-${item.id}`}
            style={{ padding: spacing.lg, marginBottom: spacing.sm, gap: spacing.sm, borderRadius: radius.lg, borderCurve: radiusCurve,
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme) }}>
            <View style={{ flexDirection: verticalHeading ? 'column' : 'row', justifyContent: 'space-between', gap: spacing.md }}>
              <AppText variant="headline" style={verticalHeading ? undefined : { flex: 1 }}>{text.title}</AppText>
              <AppText variant="headline" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}
                style={{ flexShrink: 1, fontVariant: ['tabular-nums'], color: item.delta > 0 ? brand.accent[scheme] : semanticColor('label', scheme) }}>{text.delta}</AppText>
            </View>
            <AppText variant="subheadline" style={{ color: semanticColor('secondaryLabel', scheme) }}>{text.subtitle}</AppText>
            {text.explanation ? <AppText variant="footnote" style={{ color: semanticColor('secondaryLabel', scheme) }}>{text.explanation}</AppText> : null}
          </View>;
        }}
        ListFooterComponent={history.loadingMore ? <AppText testID="coin-history-loading-more" style={{ paddingVertical: spacing.md }}>Loading more...</AppText>
          : history.moreError ? <View style={{ paddingVertical: spacing.md, gap: spacing.md }}>
            <InlineError testID="coin-history-more-error" message={history.moreError.message} />
            <PrimaryButton title="Try again" testID="coin-history-more-retry" onPress={history.loadMore} />
          </View> : null}
      />
    </View>
  );
}
