import { Host, Picker } from '@expo/ui';
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
      <AppText style={{ flexShrink: 1 }}>Daily Coin Cap</AppText>
      <Host matchContents>
        <Picker<number> selectedValue={value} onValueChange={onChange} enabled={!disabled} appearance="menu" testID="coin-cap-picker">
          {Array.from({ length: 10 }, (_, index) => index + 1).map(cap => <Picker.Item key={cap} label={String(cap)} value={cap} />)}
        </Picker>
      </Host>
    </View>
  );
}
