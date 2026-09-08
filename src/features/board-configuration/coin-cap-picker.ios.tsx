import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { disabled as disabledModifier, frame, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { spacing } from '@/theme';

export function CoinCapPicker({ value, onChange, disabled }: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md, minHeight: minimumTouchTarget }}>
      <AppText accessible={false} style={{ flexShrink: 1 }}>Daily Coin Cap</AppText>
      <Host matchContents>
        <Picker<number>
          label="Daily Coin Cap"
          selection={value}
          onSelectionChange={onChange}
          modifiers={[pickerStyle('menu'), frame({ minHeight: minimumTouchTarget }), disabledModifier(disabled)]}
          testID="coin-cap-picker"
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map(cap => <Text key={cap} modifiers={[tag(cap)]}>{String(cap)}</Text>)}
        </Picker>
      </Host>
    </View>
  );
}
