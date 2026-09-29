import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AdaptiveMaterial } from '@/components/foundation/adaptive-material';
import { Icon } from '@/components/foundation/icon';
import { semanticFallbacks } from '@/theme';
import { ProductPressable, useScheme } from '../ui';
import type { BoardLayout } from './use-board-layout';

const options = [
  { value: 'cards', label: 'Full-width cards', icon: 'layoutCards' },
  { value: 'grid', label: 'Two-column grid', icon: 'layoutGrid' },
  { value: 'compact', label: 'Compact rows', icon: 'layoutCompact' },
] as const;

export function BoardLayoutPicker({ layout, disabled, onSelect, onClose }: {
  layout: BoardLayout; disabled: boolean; onSelect: (layout: BoardLayout) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  return (
    <View pointerEvents="box-none" testID="board-layout-picker" style={{ position: 'absolute', left: 16, right: 16,
      bottom: Math.max(insets.bottom, 16) + 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <AdaptiveMaterial style={{ borderRadius: 40, padding: 8, flexDirection: 'row' }}>
        {options.map(option => (
          <ProductPressable key={option.value} label={option.label} selected={layout === option.value}
            disabled={disabled} onPress={() => onSelect(option.value)} testID={`layout-${option.value}`}
            style={{ width: 64, height: 52, borderRadius: 32,
              backgroundColor: layout === option.value ? (scheme === 'dark' ? '#FFFFFF30' : '#00000012') : 'transparent' }}>
            <Icon name={option.icon} size={24} color={semanticFallbacks.label[scheme]} />
          </ProductPressable>
        ))}
      </AdaptiveMaterial>
      <AdaptiveMaterial style={{ padding: 0, borderRadius: 28 }}>
        <ProductPressable label="Close layout picker" testID="close-board-layout" disabled={disabled} onPress={onClose}
          style={{ width: 48, height: 48 }}>
          <Icon name="close" size={22} color={semanticFallbacks.label[scheme]} />
        </ProductPressable>
      </AdaptiveMaterial>
    </View>
  );
}
