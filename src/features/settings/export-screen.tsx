import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { exportFileName, getExportSnapshot, serializeExport } from '@/core/export/serialize';
import { getExportMeta } from '@/platform/app-metadata';
import { semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { useProduct } from '../product-store';
import { SampleDisabledScreen } from '../sample/disabled-screen';
import { useSettingsActivity } from './use-settings-activity';

// the export destination: the file can carry private notes, so the screen
// says so before the share sheet opens
export function ExportScreen() {
  const { scope } = useProduct();
  if (scope.kind === 'sample') return <SampleDisabledScreen title="Export Data" message="Export is disabled in sample mode." />;
  return <ExportBody />;
}

function ExportBody() {
  const scheme = useScheme();
  const { scope } = useProduct();
  const activity = useSettingsActivity(scope);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const meta = getExportMeta();

  const exportData = useCallback(async () => {
    if (!activity.active || busy.current) return;
    busy.current = true;
    setExporting(true);
    setError(null);
    setShared(false);
    try {
      const dispatch = await scope.run(async ({ core, effects }) => {
        if (effects.kind !== 'real') throw new Error('Export is disabled in sample mode.');
        const snapshot = await getExportSnapshot(core, meta);
        if (!snapshot.ok) return snapshot;
        return effects.saveAndShareExport(serializeExport(snapshot.value), exportFileName(snapshot.value.exportedAtUtc));
      });
      if (!activity.active || !mounted.current || !dispatch.started) return;
      if (!dispatch.value.ok) setError(dispatch.value.error.message);
      else setShared(true);
    } catch {
      if (activity.active && mounted.current) setError('The export could not be shared. Try again.');
    } finally {
      busy.current = false;
      if (mounted.current) setExporting(false);
    }
  }, [scope, activity, meta]);

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'Export Data' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        <AppText>
          The export is one JSON file with your habits, check-ins, notes, amounts, reminder
          rules, rewards, coin history, and anchor times.
        </AppText>
        <AppText variant="footnote">
          It contains your private notes. Share it only with people you trust. Importing it back
          into this app keeps existing records and does not earn coins again.
        </AppText>
        <PrimaryButton
          title={exporting ? 'Preparing…' : 'Export Data'}
          onPress={() => void exportData()}
          disabled={exporting}
          testID="export-start"
        />
        {shared ? (
          <AppText variant="footnote" testID="export-shared">
            The export file is ready in the share sheet.
          </AppText>
        ) : null}
        {error ? <InlineError message={error} testID="export-error" /> : null}
      </ScrollView>
    </View>
  );
}
