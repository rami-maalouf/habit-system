import { BottomSheet, RNHostView } from '@expo/ui';
import { useState, type ReactNode } from 'react';
import { Keyboard, ScrollView, TextInput, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { normalizeBoardAnchorFields, type BoardAnchorInput } from '@/core/domain/board-anchor';
import type { AnchorRelation } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';
import { getAnchorPickerOptions } from '@/core/domain/queries';
import { minimumTouchTarget } from '@/foundation/accessibility';
import { radius, radiusCurve, semanticColor, semanticFallbacks, spacing } from '@/theme';

import { useProduct, useProductQuery } from '../product-store';
import { useProductActivity } from '../product-store/use-product-activity';
import { SampleChrome } from '../sample/chrome';
import { formatMinuteOfDay } from '../reminders/weekdays';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { AnchorRelationPicker } from './anchor-relation-picker';
import { anchorPresets } from './presets';

function AnchorChoice({ label, selected, onPress, testID, children }: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  children: ReactNode;
}) {
  const scheme = useScheme();
  return (
    <ProductPressable label={label} selected={selected} onPress={onPress} stretch testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ flex: 1 }}>{children}</View>
        <View style={{ width: 20 }} accessible={false}>
          {selected ? <Icon name="checkmark" size={18} color={semanticFallbacks.label[scheme]} /> : null}
        </View>
      </View>
    </ProductPressable>
  );
}

export function AnchorPicker({ boardId, anchor, onDone, onDismiss }: {
  boardId: BoardId | null;
  anchor: BoardAnchorInput | null;
  onDone: (anchor: BoardAnchorInput | null) => void;
  onDismiss: () => void;
}) {
  const scheme = useScheme();
  const { scope } = useProduct();
  const activity = useProductActivity(scope);
  const options = useProductQuery(getAnchorPickerOptions, []);
  const [selection, setSelection] = useState(anchor);
  const [relation, setRelation] = useState<AnchorRelation>(anchor?.relation ?? 'after');
  const [text, setText] = useState(anchor?.kind === 'text' ? anchor.text : '');
  const [error, setError] = useState<string | null>(null);

  function choose(next: BoardAnchorInput | null) {
    if (!activity.active) return;
    setSelection(next);
    setError(null);
  }

  function done() {
    if (!activity.active || options.status !== 'ready') return;
    const selected = selection ? { ...selection, relation } : null;
    const normalized = normalizeBoardAnchorFields({ anchor: selected });
    if (!normalized.ok) {
      setError(normalized.error.message);
      return;
    }
    Keyboard.dismiss();
    onDone(selected?.kind === 'text' ? { ...selected, text: selected.text.trim() } : selected);
  }

  function dismiss() { if (activity.active) onDismiss(); }

  return (
    <BottomSheet isPresented onDismiss={dismiss} snapPoints={['full']} contentPadding={{ top: spacing.md }} containerColor={semanticColor('groupedBackground', scheme)} testID="anchor-picker-sheet">
      <RNHostView>
        <View style={{ flexGrow: 1, height: 0 }} accessibilityViewIsModal>
          <SampleChrome />
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm }}>
              <ProductPressable label="Cancel anchor selection" onPress={dismiss} testID="anchor-picker-cancel"><AppText>Cancel</AppText></ProductPressable>
              <AppText variant="headline" accessibilityRole="header">Anchor</AppText>
              <ProductPressable label="Done choosing anchor" onPress={done} disabled={options.status !== 'ready'} testID="anchor-picker-done"><AppText variant="headline">Done</AppText></ProductPressable>
            </View>
            <AnchorRelationPicker relation={relation} onChange={(next) => { if (activity.active) setRelation(next); }} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg }} testID="anchor-picker-content">
            {options.status === 'ready' ? (
              <>
                <AnchorChoice label="No anchor" selected={selection === null} onPress={() => choose(null)} testID="anchor-clear"><AppText>No anchor</AppText></AnchorChoice>
                <View style={{ gap: spacing.sm }} testID="anchor-habits">
                  <AppText variant="headline" accessibilityRole="header">Habits</AppText>
                  {options.value.boards.filter((board) => board.id !== boardId).map((board) => (
                    <AnchorChoice key={board.id} label={`${board.title}${board.archivedAt !== null ? ', Archived' : ''}`} selected={selection?.kind === 'board' && selection.boardId === board.id} onPress={() => choose({ kind: 'board', relation, boardId: board.id })} testID={`anchor-board-${board.id}`}>
                      <View style={{ flex: 1, gap: spacing.xs }}>
                        <AppText>{board.title}</AppText>
                        {board.archivedAt !== null ? <AppText variant="footnote">Archived</AppText> : null}
                      </View>
                    </AnchorChoice>
                  ))}
                  {options.value.boards.every((board) => board.id === boardId) ? <AppText variant="footnote">Your other habits will appear here.</AppText> : null}
                </View>
                <View style={{ gap: spacing.sm }}>
                  <AppText variant="headline" accessibilityRole="header">Built-in anchors</AppText>
                  {anchorPresets.map(({ preset, label }) => (
                    <AnchorChoice key={preset} label={`${label}, ${formatMinuteOfDay(options.value.presetMinutes[preset])}`} selected={selection?.kind === 'preset' && selection.preset === preset} onPress={() => choose({ kind: 'preset', relation, preset })} testID={`anchor-preset-${preset}`}>
                      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }}>
                        <AppText>{label}</AppText><AppText variant="footnote">{formatMinuteOfDay(options.value.presetMinutes[preset])}</AppText>
                      </View>
                    </AnchorChoice>
                  ))}
                </View>
                <View style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}><AppText variant="headline" accessibilityRole="header">Text</AppText>{selection?.kind === 'text' ? <Icon name="checkmark" size={18} color={semanticFallbacks.label[scheme]} /> : null}</View>
                  <TextInput accessibilityLabel="Text anchor" placeholder="For example, getting home" value={text} onFocus={() => choose({ kind: 'text', relation, text })} onChangeText={(value) => { if (!activity.active) return; setText(value); choose({ kind: 'text', relation, text: value }); }} multiline placeholderTextColor={semanticColor('secondaryLabel', scheme) as string} style={{ minHeight: minimumTouchTarget, padding: spacing.md, fontSize: 17, color: semanticColor('label', scheme) as string, backgroundColor: semanticColor('secondaryGroupedBackground', scheme), borderRadius: radius.md, borderCurve: radiusCurve }} testID="anchor-text-input" />
                  <AppText variant="footnote">Describe your anchor in 1 to 80 characters.</AppText>
                </View>
              </>
            ) : options.status === 'loading' ? <AppText>Loading anchors…</AppText> : (
              <View style={{ gap: spacing.md }}><InlineError message="Anchors could not be loaded. Try again." testID="anchor-picker-load-error" /><PrimaryButton title="Retry" onPress={() => { if (activity.active) options.refresh(); }} testID="anchor-picker-retry" /></View>
            )}
            {error ? <InlineError message={error} testID="anchor-picker-error" /> : null}
          </ScrollView>
        </View>
      </RNHostView>
    </BottomSheet>
  );
}
