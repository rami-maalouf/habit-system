import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { frame, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { BoardKind } from '@/core/domain/entities';
import { minimumTouchTarget } from '@/foundation/accessibility';

// the universal picker has no label prop; the native label supplies the
// control's name to voiceover while retaining the selected value.
export function BoardKindPicker({ kind, onChange }: {
  kind: BoardKind;
  onChange: (kind: BoardKind) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: minimumTouchTarget }}>
      <AppText accessible={false}>Kind</AppText>
      <Host matchContents>
        <Picker<BoardKind>
          label="Kind"
          selection={kind}
          onSelectionChange={onChange}
          modifiers={[pickerStyle('menu'), frame({ minHeight: minimumTouchTarget })]}
          testID="board-kind-picker"
        >
          <Text modifiers={[tag('daily')]}>Daily</Text>
          <Text modifiers={[tag('count')]}>Count</Text>
        </Picker>
      </Host>
    </View>
  );
}
