import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { disabled as disabledModifier, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';

import { formatMinuteOfDay } from '../reminders/weekdays';

const minutes = Array.from({ length: 96 }, (_, index) => index * 15);

export function AnchorMinutePicker({ label, minute, disabled, onChange, testID }: {
  label: string;
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
  testID: string;
}) {
  return (
    <Host style={{ width: '100%', height: 216 }}>
      <Picker<number>
        label={label}
        selection={minute}
        onSelectionChange={onChange}
        modifiers={[pickerStyle('wheel'), disabledModifier(disabled)]}
        testID={testID}
      >
        {minutes.map((value) => (
          <Text key={value} modifiers={[tag(value)]}>{formatMinuteOfDay(value)}</Text>
        ))}
      </Picker>
    </Host>
  );
}
