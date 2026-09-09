import { useContext } from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { ProductContext } from '@/features/product-store/context';
import { ProductPressable, useScheme } from '@/features/ui/primitives';
import { brand, semanticColor, spacing } from '@/theme';

import { useOptionalSampleSession, useSampleSnapshot } from './session-context';

// native sheets reuse this banner inside their own presentation boundary.
export function SampleChrome({ always = false }: { always?: boolean }) {
  const product = useContext(ProductContext);
  const session = useOptionalSampleSession();
  const snapshot = useSampleSnapshot();
  const scheme = useScheme();
  if (!session || (!always && product?.scope.kind !== 'sample')) return null;
  return <View testID="sample-chrome" style={{
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm, backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
  }}>
    <AppText variant="footnote" style={{ flex: 1 }}>Sample data. Nothing here is saved.</AppText>
    <ProductPressable label="Close sample" testID="sample-close" disabled={snapshot.status === 'closing'}
      onPress={() => { void session.close().catch(() => {}); }}>
      <AppText variant="headline" selectable={false} style={{ color: brand.accent[scheme] }}>Close</AppText>
    </ProductPressable>
  </View>;
}
