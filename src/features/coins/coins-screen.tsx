import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { getCoinTotals } from '@/core/domain/coin-queries';
import { radius, radiusCurve, semanticColor, semanticFallbacks, spacing } from '@/theme';

import { useProductQuery } from '../product-store';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { coinAmountLabel } from './history-presentation';
import { RewardsList } from '../rewards/rewards-list';

export function CoinsScreen() {
  const router = useRouter();
  const scheme = useScheme();
  const { fontScale } = useWindowDimensions();
  const totals = useProductQuery(getCoinTotals, []);
  const verticalTotals = fontScale > 1.3 || (totals.status === 'ready'
    && (String(totals.value.earned).length > 9 || String(totals.value.spent).length > 9));
  const [scrollReady, setScrollReady] = useState(false);
  const card = { padding: spacing.lg, gap: spacing.md, borderRadius: radius.lg, borderCurve: radiusCurve,
    backgroundColor: semanticColor('secondaryGroupedBackground', scheme) } as const;
  const secondary = { color: semanticColor('secondaryLabel', scheme) };
  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Coins', scrollEdgeEffects: { top: scrollReady ? 'soft' : 'automatic' } }} />
      <RewardsList onLayout={() => setScrollReady(true)} header={<View style={{ gap: spacing.lg }}>
        {totals.status === 'loading' ? <AppText testID="coins-loading">Loading coins...</AppText>
          : totals.status === 'error' ? <View style={{ gap: spacing.md }}>
            <InlineError message={totals.error.message} testID="coins-error" />
            <PrimaryButton title="Try again" testID="coins-retry" onPress={totals.refresh} />
          </View> : <>
            <View style={{ ...card, padding: spacing.xl, gap: spacing.lg }}>
              <View style={{ gap: spacing.xs }}>
                <AppText variant="subheadline" style={secondary}>Available balance</AppText>
                <AppText variant="largeTitle" testID="coins-balance" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}
                  accessibilityLabel={`Available balance, ${coinAmountLabel(totals.value.balance)}`}
                  style={{ fontVariant: ['tabular-nums'] }}>{totals.value.balance}</AppText>
                {totals.value.balance < 0 ? <AppText variant="footnote" style={secondary}>New earnings will pay back this balance.</AppText> : null}
              </View>
              <View style={{ flexDirection: verticalTotals ? 'column' : 'row', gap: spacing.xl }}>
                <View style={{ flex: verticalTotals ? undefined : 1, gap: spacing.xs }}>
                  <AppText variant="footnote" style={secondary}>Earned</AppText>
                  <AppText variant="title2" testID="coins-earned" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}
                    accessibilityLabel={`Earned, ${coinAmountLabel(totals.value.earned)}`} style={{ fontVariant: ['tabular-nums'] }}>{totals.value.earned}</AppText>
                </View>
                <View style={{ flex: verticalTotals ? undefined : 1, gap: spacing.xs }}>
                  <AppText variant="footnote" style={secondary}>Spent</AppText>
                  <AppText variant="title2" testID="coins-spent" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}
                    accessibilityLabel={`Spent, ${coinAmountLabel(totals.value.spent)}`} style={{ fontVariant: ['tabular-nums'] }}>{totals.value.spent}</AppText>
                </View>
              </View>
            </View>
            <AppText variant="footnote" style={{ ...secondary, paddingHorizontal: spacing.xs }}>Totals include earnings, claims, reversals and balance adjustments.</AppText>
          </>}
        <ProductPressable label="Coin History" hint="Shows your coin activity" testID="coins-history-link" stretch onPress={() => router.push('/coins/history')}
          style={{ ...card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <AppText variant="headline" style={{ flexShrink: 1 }}>Coin History</AppText>
          <Icon name="chevronRight" color={semanticFallbacks.secondaryLabel[scheme]} />
        </ProductPressable>
      </View>} />
    </View>
  );
}
