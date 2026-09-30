// behavior-focused test double for @expo/ui/swift-ui: layout shapes render
// as views, buttons press, and List.ForEach exposes per-row delete triggers
// so tests can drive the native swipe-to-delete path
import type { ReactNode } from 'react';
import { Pressable, Text as RNText, View } from 'react-native';
import React from 'react';

type AnyProps = { children?: ReactNode; testID?: string } & Record<string, unknown>;

export function Text({ children }: AnyProps) {
  return <RNText>{children}</RNText>;
}

export function Label({ title }: AnyProps & { title?: string }) {
  return <RNText>{title}</RNText>;
}

export function HStack({ children, modifiers }: AnyProps & { modifiers?: unknown[] }) {
  // an onTapGesture modifier makes the mocked stack pressable, mirroring
  // the native tap-gesture row
  const tap = (modifiers ?? []).find(
    (modifier): modifier is { __onTap: () => void } =>
      typeof modifier === 'object' && modifier !== null && '__onTap' in modifier,
  );
  if (tap) {
    return (
      <Pressable accessibilityRole="button" onPress={tap.__onTap}>
        {children}
      </Pressable>
    );
  }
  return <View>{children}</View>;
}

export function VStack({ children }: AnyProps) {
  return <View>{children}</View>;
}

export function Spacer() {
  return <View />;
}

export function Picker({ label, selection, onSelectionChange, children, testID, modifiers }: AnyProps & {
  label?: string;
  selection?: string | number;
  onSelectionChange?: (value: string | number) => void;
  modifiers?: { __disabled?: boolean; __pickerStyle?: string }[];
}) {
  const isDisabled = modifiers?.some((modifier) => modifier.__disabled === true) ?? false;
  if (modifiers?.some(modifier => modifier.__pickerStyle === 'segmented')) {
    return <View testID={testID}>{React.Children.map(children, child => {
      if (!React.isValidElement<{ title?: string; modifiers?: { __tag?: string | number; __identifier?: string }[] }>(child)) return child;
      const value = child.props.modifiers?.find(modifier => modifier.__tag !== undefined)?.__tag;
      const identifier = child.props.modifiers?.find(modifier => modifier.__identifier)?.__identifier;
      return <Pressable accessibilityRole="button" accessibilityLabel={child.props.title}
        accessibilityState={{ selected: value === selection, disabled: isDisabled }} testID={identifier}
        disabled={isDisabled} onPress={() => { if (value !== undefined) onSelectionChange?.(value); }}>{child}</Pressable>;
    })}</View>;
  }
  const selected = React.Children.toArray(children).find((child) =>
    React.isValidElement<{ modifiers?: { __tag?: unknown }[] }>(child) &&
    child.props.modifiers?.some((modifier) => modifier.__tag === selection),
  );
  const selectedLabel = React.isValidElement<{ children?: ReactNode }>(selected)
    ? String(selected.props.children) : String(selection);
  return (
    <View
      accessible
      accessibilityRole="combobox"
      accessibilityLabel={label}
      accessibilityValue={{ text: selectedLabel }}
      accessibilityState={{ disabled: isDisabled }}
      testID={testID}
      {...{ onSelectionChange: isDisabled ? undefined : onSelectionChange }}
    >
      {children}
    </View>
  );
}

export function pickerStyle(style: string) { return { __pickerStyle: style }; }
export function controlSize() { return {}; }
export function labelStyle() { return {}; }
export function padding() { return {}; }
export function glassEffect() { return {}; }
export function accessibilityIdentifier(value: string) { return { __identifier: value }; }
export function frame() { return {}; }
export function tag(value: string | number) { return { __tag: value }; }
export function disabled(value: boolean) { return { __disabled: value }; }

export function Section({ title, children }: AnyProps & { title?: string }) {
  return (
    <View>
      {title ? <RNText>{title}</RNText> : null}
      {children}
    </View>
  );
}

export function Button({ onPress, children, testID }: AnyProps & { onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
      {children}
    </Pressable>
  );
}

function ListForEach({
  children,
  onDelete,
}: AnyProps & { onDelete?: (indices: number[]) => void }) {
  const items = React.Children.toArray(children);
  return (
    <View>
      {items.map((child, index) => (
        <View key={index}>
          {child}
          {onDelete ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete row ${index}`}
              testID={`swipe-delete-${index}`}
              onPress={() => onDelete([index])}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function List({ children }: AnyProps) {
  return <View>{children}</View>;
}
List.ForEach = ListForEach;

// modifier factories from @expo/ui/swift-ui/modifiers resolve here too; the
// mocked components ignore the configs except the tap gesture, which HStack
// turns into a pressable
export function buttonStyle() {
  return {};
}

export function foregroundStyle() {
  return {};
}

export function contentShape() {
  return {};
}

export function onTapGesture(handler: () => void) {
  return { __onTap: handler };
}

export const shapes = {
  rectangle: () => ({}),
};
