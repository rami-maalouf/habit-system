import { View } from 'react-native';

import { Icon } from '@/components/foundation/icon';
import { radius, radiusCurve, spacing } from '@/theme';

import type { DerivedBoardColors } from './board-colors';

export function DailyStrip({ strip, colors, testID }: {
  strip: number[];
  colors: DerivedBoardColors;
  testID?: string;
}) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', gap: spacing.xs }}
    >
      {strip.map((value, index) => (
        <View
          key={index}
          testID={testID ? `${testID}-day-${index}` : undefined}
          style={{
            flex: 1,
            aspectRatio: 1,
            maxHeight: 24,
            borderRadius: radius.sm,
            borderCurve: radiusCurve,
            borderWidth: index === strip.length - 1 ? 2 : 1,
            borderColor: value > 0 || index === strip.length - 1 ? colors.accent : colors.inactiveBar,
            backgroundColor: value > 0 ? colors.accent : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {value > 0 ? <Icon name="checkmark" size={10} color={colors.onAccent} /> : null}
        </View>
      ))}
    </View>
  );
}
