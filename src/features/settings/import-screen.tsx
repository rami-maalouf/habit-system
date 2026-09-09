import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { ImportDraft } from '@/core/export/import-parsers';
import { parseOwnExport, parseRipplesCsv } from '@/core/export/import-parsers';
import { pickImportFile } from '@/platform/data-transfer';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { useProduct } from '../product-store';
import { SettingsGroup, SettingsRow } from './rows';
import { importAttemptStoreFor, type ImportOwner } from './import-attempt';

type ImportState =
  | { step: 'choose' }
  | { step: 'preview'; fileName: string; draft: ImportDraft };

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

// two import sources: a ripples csv export from the original app, and this
// app's own json export (a restore that skips records it already has)
export function ImportScreen() {
  const scheme = useScheme();
  const { core, invalidate, nextCommandId } = useProduct();
  const store = useMemo(() => importAttemptStoreFor(core), [core]);
  const attempt = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const owner = useRef<ImportOwner | null>(null);
  const picking = useRef<ImportOwner | null>(null);
  const [state, setState] = useState<ImportState>({ step: 'choose' });
  const selection = useRef<ImportState>(state);
  const [pickError, setPickError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    const current = { active: true }; owner.current = current;
    return () => { current.active = false; };
  }, []));
  useEffect(() => store.registerInvalidation(invalidate), [store, invalidate]);

  const pick = useCallback(
    async (source: 'ripples-csv' | 'own') => {
      const current = owner.current;
      if (!current?.active || picking.current === current || store.getSnapshot().phase !== 'idle') return;
      picking.current = current;
      setPickError(null);
      try {
        const picked = await pickImportFile();
        if (!current.active || store.getSnapshot().phase !== 'idle') return;
        if (!picked.ok) {
          setPickError(picked.error.message);
          return;
        }
        if (picked.value === null) {
          // cancelling the picker keeps the chooser open
          return;
        }
        const parsed =
          source === 'ripples-csv'
            ? parseRipplesCsv(picked.value.contents)
            : parseOwnExport(picked.value.contents);
        if (!parsed.ok) {
          setPickError(parsed.error.message);
          return;
        }
        const preview: ImportState = { step: 'preview', fileName: picked.value.name, draft: parsed.value };
        selection.current = preview;
        setState(preview);
      } catch {
        if (current.active) setPickError('The file could not be read. Try again.');
      } finally {
        if (picking.current === current) picking.current = null;
      }
    },
    [store],
  );

  const runImport = useCallback(async () => {
    const current = owner.current;
    if (!current?.active) return;
    setPickError(null);
    try {
      if (attempt.phase === 'uncertain') await store.retry(current, attempt.commandId, invalidate);
      else if (attempt.phase === 'idle' && state.step === 'preview' && selection.current === state) {
        const pending = store.start(current, state.fileName, state.draft, nextCommandId, invalidate);
        if (store.getSnapshot().phase === 'running') {
          selection.current = { step: 'choose' };
          setState(selection.current);
        }
        await pending;
      }
    } catch {
      if (current.active) setPickError('The import could not be started. Try again.');
    }
  }, [store, invalidate, nextCommandId, state, attempt]);

  const preview = attempt.phase === 'running' || attempt.phase === 'uncertain' ? attempt
    : attempt.phase === 'idle' && state.step === 'preview'
      ? { fileName: state.fileName, source: state.draft.source, boards: state.draft.boards.length, checkIns: state.draft.checkIns.length }
      : null;
  const error = attempt.phase === 'uncertain' || attempt.phase === 'failed' ? attempt.error?.message : pickError;
  const another = () => {
    const current = owner.current;
    if (current && (attempt.phase === 'done' || attempt.phase === 'failed') && store.startAnother(current, attempt.commandId)) {
      selection.current = { step: 'choose' };
      setState(selection.current); setPickError(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Import Data' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        {attempt.phase === 'idle' && state.step === 'choose' ? (
          <>
            <AppText variant="subheadline">
              Imports add to your existing boards. Nothing is deleted or overwritten.
            </AppText>
            <SettingsGroup title="Import from">
              <SettingsRow
                title="Ripples (CSV export)"
                onPress={() => void pick('ripples-csv')}
                testID="import-ripples"
              />
              <SettingsRow
                title="This app (JSON export)"
                onPress={() => void pick('own')}
                testID="import-own"
              />
            </SettingsGroup>
          </>
        ) : null}

        {preview ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="import-preview"
          >
            <AppText variant="headline">{preview.fileName}</AppText>
            <AppText testID="import-preview-counts">
              {`${count(preview.boards, 'board')}, ${count(preview.checkIns, 'check-in')}.`}
            </AppText>
            <AppText variant="footnote">
              {preview.source === 'ripples-csv'
                ? 'Boards keep their original creation dates, so streaks and consistency include the imported history.'
                : 'Records that already exist are skipped, so restoring the same file twice is safe.'}
            </AppText>
            <PrimaryButton
              title={attempt.phase === 'running' ? 'Importing…' : attempt.phase === 'uncertain' ? 'Retry import' : 'Import'}
              onPress={() => void runImport()}
              disabled={attempt.phase === 'running'}
              testID="import-confirm"
            />
          </View>
        ) : null}

        {attempt.phase === 'done' ? (
          <View
            style={{
              backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
              borderRadius: radius.lg,
              borderCurve: radiusCurve,
              padding: spacing.lg,
              gap: spacing.md,
            }}
            testID="import-done"
          >
            <AppText variant="headline">Import complete</AppText>
            <AppText testID="import-summary">
              {`Added ${count(attempt.summary.boardsCreated, 'board')} and ${count(attempt.summary.checkInsCreated, 'check-in')}.${
                attempt.summary.boardsSkipped + attempt.summary.checkInsSkipped > 0
                  ? ` Skipped ${count(attempt.summary.boardsSkipped, 'board')} and ${count(attempt.summary.checkInsSkipped, 'check-in')} that already existed or were invalid.`
                  : ''
              }`}
            </AppText>
            <PrimaryButton
              title="Import another file"
              onPress={another}
              testID="import-again"
            />
          </View>
        ) : null}

        {attempt.phase === 'failed' ? <PrimaryButton title="Import another file" onPress={another} testID="import-again" /> : null}

        {error ? <InlineError message={error} testID="import-error" /> : null}
      </ScrollView>
    </View>
  );
}
