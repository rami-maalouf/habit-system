import { Host } from '@expo/ui';
import { Label, Picker } from '@expo/ui/swift-ui';
import { accessibilityIdentifier, controlSize, disabled as disabledModifier, frame, glassEffect,
  labelStyle, padding, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';

import { icons } from '@/components/foundation/icon';
import { useScheme } from '../ui';
import { boardLayoutOptions, type BoardLayoutControlProps } from './board-layout-options';

export function BoardLayoutControl({ layout, disabled, width, onSelect }: BoardLayoutControlProps) {
  const scheme = useScheme();
  return (
    <Host colorScheme={scheme} style={{ width, height: 76 }}>
      <Picker label="Board layout" selection={layout} onSelectionChange={onSelect} testID="native-board-layout"
        modifiers={[pickerStyle('segmented'), controlSize('extraLarge'), labelStyle('iconOnly'),
          disabledModifier(disabled), frame({ width: width - 24, height: 52 }), padding({ all: 12 }),
          glassEffect({ glass: { variant: 'regular', interactive: true }, shape: 'capsule' })]}>
        {boardLayoutOptions.map(option => (
          <Label key={option.value} title={option.label} systemImage={icons[option.icon].sfSymbol}
            modifiers={[tag(option.value), accessibilityIdentifier(`layout-${option.value}`)]} />
        ))}
      </Picker>
    </Host>
  );
}
