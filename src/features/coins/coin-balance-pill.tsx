import { useWindowDimensions, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { getCoinTotals } from '@/core/domain/coin-queries';
import { brand, radius, semanticColor, spacing } from '@/theme';

import { useProductRouter } from '../sample/navigation';
import { useProductQuery } from '../product-store';
import { ProductPressable, useScheme } from '../ui';
import { coinAmountLabel } from './history-presentation';

export function CoinBalancePill() {
  const router = useProductRouter();
  const scheme = useScheme();
  const { width } = useWindowDimensions();
  const totals = useProductQuery(getCoinTotals, []);
  const amount = totals.status === 'ready' ? String(totals.value.balance) : 'Coins';
  const label = totals.status === 'ready' ? `Coin balance, ${coinAmountLabel(totals.value.balance)}`
    : totals.status === 'loading' ? 'Coin balance loading' : 'Coin balance unavailable';
  return (
    <ProductPressable label={label} hint="Opens Coins" testID="coin-balance-pill" onPress={() => router.push('/coins')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs, maxWidth: Math.max(44, Math.min(104, width / 2 - 104)),
        borderRadius: radius.capsule, backgroundColor: semanticColor('fill', scheme) }}>
        {amount.length <= 6 ? <View accessible={false} style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: brand.accent[scheme] }} /> : null}
        <AppText variant="headline" selectable={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.35} maxFontSizeMultiplier={1.3}
          style={{ flexShrink: 1, fontVariant: ['tabular-nums'], color: brand.accent[scheme] }}>
          {amount}
        </AppText>
      </View>
    </ProductPressable>
  );
}
