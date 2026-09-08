import { DropdownMenuItem, ExposedDropdownMenu, ExposedDropdownMenuBox, TextField } from '@expo/ui/jetpack-compose';
import { act, render, screen, within } from '@testing-library/react-native';
import { useState } from 'react';

import { CoinCapPicker } from '@/features/board-configuration/coin-cap-picker.android';

// this local double exposes native slots and callbacks, not talkback behavior.
jest.mock('@expo/ui/jetpack-compose', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  type MockContent = { children?: React.ReactNode };
  function Slot({ children }: MockContent) { return <View>{children}</View>; }
  function Field({ children }: MockContent) { return <View>{children}</View>; }
  function Item({ children }: MockContent) { return <View>{children}</View>; }
  function Menu({ children }: MockContent) { return <View>{children}</View>; }
  function Box({ children }: MockContent) { return <View>{children}</View>; }
  return {
    Text,
    TextField: Object.assign(Field, { Label: Slot }),
    DropdownMenuItem: Object.assign(Item, { Text: Slot }),
    ExposedDropdownMenu: Menu,
    ExposedDropdownMenuBox: Box,
    useNativeState(initial: string) {
      const [state] = React.useState(() => ({ value: initial, set(next: string) { this.value = next; } }));
      return state;
    },
  };
});

jest.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  fillMaxWidth: () => ({ $type: 'fillMaxWidth' }),
  menuAnchor: (type: string, enabled: boolean) => ({ $type: 'menuAnchor', type, enabled }),
  testID: (value: string) => ({ $type: 'testID', testID: value }),
}));

describe('Android coin cap native control', () => {
  it('associates the label with the read-only selected field and offers caps one through ten', () => {
    const change = jest.fn();
    render(<CoinCapPicker value={7} onChange={change} disabled={false} />);
    const field = screen.UNSAFE_getByType(TextField);
    expect(within(field).getByText('Daily Coin Cap')).toBeTruthy();
    expect(field.findByType(TextField.Label)).toBeTruthy();
    expect(field.props.value.value).toBe('7');
    expect(field.props.readOnly).toBe(true);
    expect(field.props.enabled).toBe(true);
    expect(field.props.modifiers).toEqual(expect.arrayContaining([
      { $type: 'testID', testID: 'coin-cap-picker' },
      { $type: 'menuAnchor', type: 'primaryNotEditable', enabled: true },
    ]));
    const options = screen.UNSAFE_getAllByType(DropdownMenuItem);
    expect(options).toHaveLength(10);
    options.forEach((option, index) => expect(within(option).getByText(String(index + 1))).toBeTruthy());
    expect(change).not.toHaveBeenCalled();
  });

  it('updates the existing native observable when the saved or draft prop changes', () => {
    const change = jest.fn();
    const view = render(<CoinCapPicker value={1} onChange={change} disabled={false} />);
    const state = screen.UNSAFE_getByType(TextField).props.value;
    view.rerender(<CoinCapPicker value={10} onChange={change} disabled={false} />);
    expect(screen.UNSAFE_getByType(TextField).props.value).toBe(state);
    expect(state.value).toBe('10');
    expect(change).not.toHaveBeenCalled();
  });

  it('delivers a numeric cap, displays the parent update and closes or dismisses the menu', () => {
    const change = jest.fn();
    function Form() {
      const [value, setValue] = useState(1);
      return <CoinCapPicker value={value} disabled={false} onChange={next => { change(next); setValue(next); }} />;
    }
    render(<Form />);
    act(() => screen.UNSAFE_getByType(ExposedDropdownMenuBox).props.onExpandedChange(true));
    expect(screen.UNSAFE_getByType(ExposedDropdownMenu).props.expanded).toBe(true);
    act(() => screen.UNSAFE_getAllByType(DropdownMenuItem)[9].props.onClick());
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith(10);
    expect(screen.UNSAFE_getByType(TextField).props.value.value).toBe('10');
    expect(screen.UNSAFE_getByType(ExposedDropdownMenu).props.expanded).toBe(false);
    act(() => screen.UNSAFE_getByType(ExposedDropdownMenuBox).props.onExpandedChange(true));
    act(() => screen.UNSAFE_getByType(ExposedDropdownMenu).props.onDismissRequest());
    expect(screen.UNSAFE_getByType(ExposedDropdownMenu).props.expanded).toBe(false);
  });

  it('blocks queued expansion and selection callbacks while a save disables the control', () => {
    const change = jest.fn();
    const view = render(<CoinCapPicker value={7} onChange={change} disabled={false} />);
    act(() => screen.UNSAFE_getByType(ExposedDropdownMenuBox).props.onExpandedChange(true));
    view.rerender(<CoinCapPicker value={7} onChange={change} disabled />);
    expect(screen.UNSAFE_getByType(TextField).props.enabled).toBe(false);
    expect(screen.UNSAFE_getByType(ExposedDropdownMenu).props.expanded).toBe(false);
    expect(screen.UNSAFE_getByType(TextField).props.modifiers).toContainEqual(
      { $type: 'menuAnchor', type: 'primaryNotEditable', enabled: false },
    );
    act(() => {
      screen.UNSAFE_getByType(ExposedDropdownMenuBox).props.onExpandedChange(true);
      screen.UNSAFE_getAllByType(DropdownMenuItem)[1].props.onClick();
    });
    expect(change).not.toHaveBeenCalled();
    expect(screen.UNSAFE_getByType(TextField).props.value.value).toBe('7');
    expect(screen.UNSAFE_getByType(ExposedDropdownMenu).props.expanded).toBe(false);
    expect(screen.UNSAFE_getAllByType(DropdownMenuItem).every(option => option.props.enabled === false)).toBe(true);
    view.rerender(<CoinCapPicker value={7} onChange={change} disabled={false} />);
    act(() => screen.UNSAFE_getAllByType(DropdownMenuItem)[8].props.onClick());
    expect(change).toHaveBeenCalledWith(9);
  });
});
