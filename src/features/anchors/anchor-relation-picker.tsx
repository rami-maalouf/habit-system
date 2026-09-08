import { Host, Picker } from '@expo/ui';
import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { AnchorRelation } from '@/core/domain/entities';
import { minimumTouchTarget } from '@/foundation/accessibility';

export function AnchorRelationPicker({ relation, onChange }: {
  relation: AnchorRelation;
  onChange: (relation: AnchorRelation) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: minimumTouchTarget }}>
      <AppText>Direction</AppText>
      <Host matchContents>
        <Picker<AnchorRelation> selectedValue={relation} onValueChange={onChange} appearance="menu" testID="anchor-relation-picker">
          <Picker.Item label="After" value="after" />
          <Picker.Item label="Before" value="before" />
        </Picker>
      </Host>
    </View>
  );
}
