import { useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AdaptiveMaterial } from '@/components/foundation/adaptive-material';
import { Icon } from '@/components/foundation/icon';
import { semanticFallbacks } from '@/theme';
import { ProductPressable, useScheme } from '../ui';
import type { BoardLayout } from './use-board-layout';
import { BoardLayoutControl } from './board-layout-control';

export function BoardLayoutPicker({ layout, disabled, onSelect, onClose }: {
  layout: BoardLayout; disabled: boolean; onSelect: (layout: BoardLayout) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  const { width } = useWindowDimensions();
  return (
    <View pointerEvents="box-none" testID="board-layout-picker" style={{ position: 'absolute', left: 16, right: 16,
      bottom: Math.max(insets.bottom, 16) + 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <BoardLayoutControl layout={layout} disabled={disabled} onSelect={onSelect} width={Math.min(280, width - 92)} />
      <AdaptiveMaterial style={{ padding: 0, borderRadius: 28 }}>
        <ProductPressable label="Close layout picker" testID="close-board-layout" disabled={disabled} onPress={onClose}
          style={{ width: 48, height: 48 }}>
          <Icon name="close" size={22} color={semanticFallbacks.label[scheme]} />
        </ProductPressable>
      </AdaptiveMaterial>
    </View>
  );
}
