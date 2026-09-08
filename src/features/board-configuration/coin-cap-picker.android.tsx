import { Host } from '@expo/ui';
import { DropdownMenuItem, ExposedDropdownMenu, ExposedDropdownMenuBox, Text, TextField, useNativeState } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, menuAnchor, testID } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';

export function CoinCapPicker({ value, onChange, disabled }: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const selectedLabel = useNativeState(String(value));
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { selectedLabel.set(String(value)); }, [selectedLabel, value]);

  return (
    <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
      <ExposedDropdownMenuBox
        expanded={expanded && !disabled}
        onExpandedChange={next => setExpanded(next && !disabled)}
        modifiers={[fillMaxWidth()]}
      >
        <TextField
          value={selectedLabel}
          readOnly
          singleLine
          enabled={!disabled}
          modifiers={[fillMaxWidth(), menuAnchor('primaryNotEditable', !disabled), testID('coin-cap-picker')]}
        >
          <TextField.Label><Text>Daily Coin Cap</Text></TextField.Label>
        </TextField>
        <ExposedDropdownMenu expanded={expanded && !disabled} onDismissRequest={() => setExpanded(false)}>
          {Array.from({ length: 10 }, (_, index) => index + 1).map(cap => (
            <DropdownMenuItem
              key={cap}
              enabled={!disabled}
              onClick={() => {
                if (disabled) return;
                onChange(cap);
                setExpanded(false);
              }}
            >
              <DropdownMenuItem.Text><Text>{String(cap)}</Text></DropdownMenuItem.Text>
            </DropdownMenuItem>
          ))}
        </ExposedDropdownMenu>
      </ExposedDropdownMenuBox>
    </Host>
  );
}
