import { Host, Picker } from '@expo/ui';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { BoardKind } from '@/core/domain/entities';
import { minimumTouchTarget } from '@/foundation/accessibility';

export function BoardKindPicker({ kind, onChange }: {
  kind: BoardKind;
  onChange: (kind: BoardKind) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: minimumTouchTarget }}>
      <AppText>Kind</AppText>
      <Host matchContents>
        <Picker<BoardKind> selectedValue={kind} onValueChange={onChange} appearance="menu" testID="board-kind-picker">
          <Picker.Item label="Daily" value="daily" />
          <Picker.Item label="Count" value="count" />
        </Picker>
      </Host>
    </View>
  );
}
