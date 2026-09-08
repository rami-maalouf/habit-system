import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { frame, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { AnchorRelation } from '@/core/domain/entities';
import { minimumTouchTarget } from '@/foundation/accessibility';

// the universal picker lacks a label; swiftui supplies the control's voiceover name.
export function AnchorRelationPicker({ relation, onChange }: {
  relation: AnchorRelation;
  onChange: (relation: AnchorRelation) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: minimumTouchTarget }}>
      <AppText accessible={false}>Direction</AppText>
      <Host matchContents>
        <Picker<AnchorRelation>
          label="Direction"
          selection={relation}
          onSelectionChange={onChange}
          modifiers={[pickerStyle('menu'), frame({ minHeight: minimumTouchTarget })]}
          testID="anchor-relation-picker"
        >
          <Text modifiers={[tag('after')]}>After</Text>
          <Text modifiers={[tag('before')]}>Before</Text>
        </Picker>
      </Host>
    </View>
  );
}
