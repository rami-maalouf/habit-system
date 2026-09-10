import { Host, Switch } from '@expo/ui';
import { useState } from 'react';
import { Keyboard, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { getAnchorPickerOptions } from '@/core/domain/queries';
import { spacing } from '@/theme';

import type { BoardDraft } from '../board-configuration/draft-store';
import { useProduct, useProductQuery } from '../product-store';
import { useProductActivity } from '../product-store/use-product-activity';
import { formatMinuteOfDay } from '../reminders/weekdays';
import { InlineError, ProductPressable } from '../ui';
import { AnchorMinutePicker } from './anchor-minute-picker';
import { AnchorPicker } from './anchor-picker';
import { anchorPresets } from './presets';

export function BoardAnchorFields({ draft, onChange, disabled }: {
  draft: BoardDraft;
  onChange: (patch: Partial<BoardDraft>) => void;
  disabled: boolean;
}) {
  const { scope } = useProduct();
  const activity = useProductActivity(scope);
  const options = useProductQuery(getAnchorPickerOptions, []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [timeDraft, setTimeDraft] = useState<number | null>(null);
  const anchor = draft.anchor;
  let target = '';
  if (anchor?.kind === 'text') target = anchor.text;
  if (anchor?.kind === 'preset') target = anchorPresets.find(({ preset }) => preset === anchor.preset)?.label ?? '';
  if (anchor?.kind === 'board') {
    const board = options.status === 'ready' ? options.value.boards.find((board) => board.id === anchor.boardId) : null;
    target = board ? `${board.title}${board.archivedAt !== null ? ' (Archived)' : ''}` : options.status === 'ready' ? 'Unavailable habit' : options.status === 'error' ? 'Saved habit' : 'Loading habit…';
  }
  const summary = anchor ? `${draft.title.trim() || 'This habit'} ${anchor.relation} ${target}` : 'No anchor';

  return (
    <View style={{ gap: spacing.md }}>
      <ProductPressable label={`Anchor. ${summary}`} onPress={() => { if (!activity.active || disabled) return; Keyboard.dismiss(); setPickerOpen(true); }} disabled={disabled} stretch testID="board-anchor-row">
        <View style={{ flex: 1, gap: spacing.xs }}><AppText variant="headline">Anchor</AppText><AppText testID="anchor-summary">{summary}</AppText></View>
      </ProductPressable>
      {anchor?.kind === 'board' && options.status === 'error' ? <View style={{ gap: spacing.sm }}>
        <InlineError message="The anchor habit could not be loaded. Try again." testID="anchor-summary-error" />
        <ProductPressable label="Retry anchor summary" onPress={() => { if (activity.active && !disabled) options.refresh(); }} testID="anchor-summary-retry"><AppText>Retry</AppText></ProductPressable>
      </View> : null}
      <ProductPressable label={`Usual time, ${draft.usualTimeMinute === null ? 'Not set' : formatMinuteOfDay(draft.usualTimeMinute)}`} onPress={() => { if (!activity.active || disabled) return; Keyboard.dismiss(); setTimeDraft((minute) => minute === null ? draft.usualTimeMinute ?? 0 : null); }} disabled={disabled} stretch testID="usual-time-row">
        <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }}><AppText>Usual time</AppText><AppText>{draft.usualTimeMinute === null ? 'Not set' : formatMinuteOfDay(draft.usualTimeMinute)}</AppText></View>
      </ProductPressable>
      {timeDraft !== null ? <View style={{ gap: spacing.sm }}>
        <AnchorMinutePicker label="Usual time" minute={timeDraft} disabled={disabled} onChange={(minute) => { if (activity.active && !disabled) setTimeDraft(minute); }} testID="usual-time-picker" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }}>
          <ProductPressable label="Cancel usual time" onPress={() => { if (activity.active && !disabled) setTimeDraft(null); }} disabled={disabled} testID="usual-time-cancel"><AppText>Cancel</AppText></ProductPressable>
          <ProductPressable label="Clear usual time" onPress={() => { if (!activity.active || disabled) return; onChange({ usualTimeMinute: null }); setTimeDraft(null); }} disabled={disabled} testID="usual-time-clear"><AppText>Clear</AppText></ProductPressable>
          <ProductPressable label="Use time" onPress={() => { if (!activity.active || disabled) return; onChange({ usualTimeMinute: timeDraft }); setTimeDraft(null); }} disabled={disabled} testID="usual-time-done"><AppText variant="headline">Use time</AppText></ProductPressable>
        </View>
      </View> : null}
      <AppText variant="footnote">A time to keep in mind for this habit.</AppText>
      <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
        <Switch label="Required in stack" value={draft.requiredInStack} onValueChange={(requiredInStack) => { if (activity.active && !disabled) onChange({ requiredInStack }); }} disabled={disabled} testID="required-in-stack" />
      </Host>
      {pickerOpen ? <AnchorPicker boardId={draft.boardId} anchor={draft.anchor} onDone={(selected) => { if (!activity.active || disabled) return; onChange({ anchor: selected }); setPickerOpen(false); options.refresh(); }} onDismiss={() => { if (activity.active && !disabled) setPickerOpen(false); }} /> : null}
    </View>
  );
}
