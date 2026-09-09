import { Stack } from 'expo-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { setAnchorPresetMinute } from '@/core/domain/commands';
import type { AnchorPreset, AppSettings } from '@/core/domain/entities';
import { getAppSettings } from '@/core/domain/queries';
import { semanticColor, spacing } from '@/theme';

import { useProduct, useProductQuery } from '../product-store';
import { formatMinuteOfDay } from '../reminders/weekdays';
import { InlineError, PrimaryButton, ProductPressable, useScheme } from '../ui';
import { AnchorMinutePicker } from '../anchors/anchor-minute-picker';
import { SettingsGroup, SettingsRow } from './rows';
import { useSettingsActivity } from './use-settings-activity';

type Editor = { preset: AnchorPreset; minute: number };
type SaveAttempt = { input: Parameters<typeof setAnchorPresetMinute>[1]; settings: AppSettings };

const anchors = [
  { preset: 'wake', label: 'Waking up', field: 'wakeMinute' },
  { preset: 'lunch', label: 'Lunch', field: 'lunchMinute' },
  { preset: 'dinner', label: 'Dinner', field: 'dinnerMinute' },
  { preset: 'sleep', label: 'Sleeping', field: 'sleepMinute' },
] as const;

export function AnchorsScreen() {
  const scheme = useScheme();
  const { scope, invalidate, nextCommandId } = useProduct();
  const activity = useSettingsActivity(scope);
  const settings = useProductQuery(getAppSettings, []);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);
  const attemptRef = useRef<SaveAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saved = attempt?.settings ?? (settings.status === 'ready' ? settings.value : null);
  const locked = pending || attempt !== null;

  function replaceEditor(next: Editor | null) {
    editorRef.current = next;
    setEditor(next);
  }

  function edit(preset: AnchorPreset, minute: number) {
    if (!activity.active || pendingRef.current || attemptRef.current || editorRef.current?.preset === preset) return;
    setError(null);
    replaceEditor({ preset, minute });
  }

  function cancel() {
    if (!activity.active || pendingRef.current || attemptRef.current || editorRef.current !== editor) return;
    setError(null);
    replaceEditor(null);
  }

  async function save() {
    if (!activity.active || pendingRef.current || !editor || editorRef.current !== editor || !saved) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const accepted = await scope.run(async ({ core }) => {
      try {
        const current = attemptRef.current ?? { input: { commandId: nextCommandId(), ...editor }, settings: saved };
        attemptRef.current = current; setAttempt(current);
        const result = await setAnchorPresetMinute(core, current.input);
        if (result.ok) {
          attemptRef.current = null; editorRef.current = null;
          invalidate();
          if (mounted.current) { setAttempt(null); setEditor(null); }
        } else {
          if (!result.error.retryable) {
            attemptRef.current = null;
            if (mounted.current) setAttempt(null);
          }
          if (mounted.current) setError(result.error.message);
        }
      } catch {
        if (mounted.current) setError('The anchor time could not be saved. Try again.');
      } finally {
        pendingRef.current = false;
        if (mounted.current) setPending(false);
      }
    });
    if (!accepted.started) {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
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
                  disabled={locked}
                  onPress={() => edit(preset, saved[field])}
                  testID={`anchor-${preset}`}
                />
                {editor?.preset === preset ? (
                  <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}>
                    <AnchorMinutePicker
                      label={`${label} time`}
                      minute={editor.minute}
                      disabled={locked}
                      onChange={(minute) => {
                        if (activity.active && !pendingRef.current && !attemptRef.current && editorRef.current === editor) {
                          replaceEditor({ preset, minute });
                        }
                      }}
                      testID="anchor-minute-picker"
                    />
                    {error ? <InlineError message={error} testID="anchor-error" /> : null}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md }}>
                      <View style={{ flex: 1, minWidth: 100 }}>
                        <ProductPressable label="Cancel" onPress={cancel} disabled={locked} testID="anchor-cancel">
                          <AppText>Cancel</AppText>
                        </ProductPressable>
                      </View>
                      <View style={{ flex: 1, minWidth: 100 }}>
                        <PrimaryButton
                          title={pending ? 'Saving…' : attempt ? 'Retry' : 'Save'}
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
            <PrimaryButton title="Retry" onPress={() => { if (activity.active) settings.refresh(); }} testID="anchor-retry" />
          </View>
        )}
      </ScrollView>
    </View>
  );
}
