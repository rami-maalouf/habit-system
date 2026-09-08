import { Stack } from 'expo-router';
import { Fragment, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { setAnchorPresetMinute } from '@/core/domain/commands';
import type { AnchorPreset } from '@/core/domain/entities';
import { getAppSettings } from '@/core/domain/queries';
import { semanticColor, spacing } from '@/theme';

import { useProduct, useProductQuery } from '../product-store';
import { formatMinuteOfDay } from '../reminders/weekdays';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { AnchorMinutePicker } from '../anchors/anchor-minute-picker';
import { SettingsGroup, SettingsRow } from './rows';

const anchors = [
  { preset: 'wake', label: 'Waking up', field: 'wakeMinute' },
  { preset: 'lunch', label: 'Lunch', field: 'lunchMinute' },
  { preset: 'dinner', label: 'Dinner', field: 'dinnerMinute' },
  { preset: 'sleep', label: 'Sleeping', field: 'sleepMinute' },
] as const;

export function AnchorsScreen() {
  const scheme = useScheme();
  const { core, invalidate, nextCommandId } = useProduct();
  const settings = useProductQuery(getAppSettings, []);
  const [editor, setEditor] = useState<{ preset: AnchorPreset; minute: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const saved = settings.status === 'ready' ? settings.value : null;

  function edit(preset: AnchorPreset, minute: number) {
    if (pendingRef.current || editor?.preset === preset) return;
    setError(null);
    setEditor({ preset, minute });
  }

  function cancel() {
    if (pendingRef.current) return;
    setError(null);
    setEditor(null);
  }

  async function save() {
    if (pendingRef.current || !editor) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await setAnchorPresetMinute(core, { commandId: nextCommandId(), ...editor });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setEditor(null);
      invalidate();
    } catch {
      setError('The anchor time could not be saved. Try again.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Anchors' }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <AppText variant="footnote">These times are reference points for your habits.</AppText>
        {saved ? (
          <SettingsGroup>
            {anchors.map(({ preset, label, field }) => (
              <Fragment key={preset}>
                <SettingsRow
                  title={label}
                  detail={formatMinuteOfDay(saved[field])}
                  disabled={pending}
                  onPress={() => edit(preset, saved[field])}
                  testID={`anchor-${preset}`}
                />
                {editor?.preset === preset ? (
                  <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}>
                    <AnchorMinutePicker
                      label={`${label} time`}
                      minute={editor.minute}
                      disabled={pending}
                      onChange={(minute) => { if (!pendingRef.current) setEditor({ preset, minute }); }}
                      testID="anchor-minute-picker"
                    />
                    {error ? <InlineError message={error} testID="anchor-error" /> : null}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md }}>
                      <View style={{ flex: 1, minWidth: 100 }}>
                        <ProductPressable label="Cancel" onPress={cancel} disabled={pending} testID="anchor-cancel">
                          <AppText>Cancel</AppText>
                        </ProductPressable>
                      </View>
                      <View style={{ flex: 1, minWidth: 100 }}>
                        <PrimaryButton
                          title={pending ? 'Saving…' : 'Save'}
                          onPress={() => { void save(); }}
                          disabled={pending}
                          testID="anchor-save"
                        />
                      </View>
                    </View>
                  </View>
                ) : null}
              </Fragment>
            ))}
          </SettingsGroup>
        ) : settings.status === 'loading' ? <AppText>Loading anchor times…</AppText> : (
          <View style={{ gap: spacing.md }}>
            <InlineError message="Anchor times could not be loaded. Try again." testID="anchor-load-error" />
            <PrimaryButton title="Retry" onPress={settings.refresh} testID="anchor-retry" />
          </View>
        )}
      </ScrollView>
    </View>
  );
}
