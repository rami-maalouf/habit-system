import { Host, Picker } from '@expo/ui';

import { formatMinuteOfDay } from '../reminders/weekdays';

const minutes = Array.from({ length: 96 }, (_, index) => index * 15);

export function AnchorMinutePicker({ minute, disabled, onChange, testID }: {
  label: string;
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
  testID: string;
}) {
  return (
    <Host style={{ width: '100%', height: 216 }}>
      <Picker<number>
        selectedValue={minute}
        onValueChange={onChange}
        enabled={!disabled}
        appearance="wheel"
        testID={testID}
      >
        {minutes.map((value) => (
          <Picker.Item key={value} label={formatMinuteOfDay(value)} value={value} />
        ))}
      </Picker>
    </Host>
  );
}
