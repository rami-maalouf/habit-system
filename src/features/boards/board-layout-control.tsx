import { AdaptiveMaterial } from '@/components/foundation/adaptive-material';
import { Icon } from '@/components/foundation/icon';
import { semanticFallbacks } from '@/theme';
import { ProductPressable, useScheme } from '../ui';
import { boardLayoutOptions, type BoardLayoutControlProps } from './board-layout-options';

export function BoardLayoutControl({ layout, disabled, width, onSelect }: BoardLayoutControlProps) {
  const scheme = useScheme();
  return (
    <AdaptiveMaterial style={{ width, borderRadius: 40, padding: 8, flexDirection: 'row' }}>
      {boardLayoutOptions.map(option => (
        <ProductPressable key={option.value} label={option.label} selected={layout === option.value}
          disabled={disabled} onPress={() => onSelect(option.value)} testID={`layout-${option.value}`}
          style={{ flex: 1, height: 52, borderRadius: 32,
            backgroundColor: layout === option.value ? (scheme === 'dark' ? '#FFFFFF30' : '#00000012') : 'transparent' }}>
          <Icon name={option.icon} size={24} color={semanticFallbacks.label[scheme]} />
        </ProductPressable>
      ))}
    </AdaptiveMaterial>
  );
}
