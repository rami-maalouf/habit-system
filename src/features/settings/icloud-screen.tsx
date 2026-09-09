import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, Switch, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { setICloudSyncEnabled } from '@/core/domain/commands';
import { getSyncSummary } from '@/core/domain/queries';
import type { SyncStatus } from '@/core/sync/engine';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { InlineError, PrimaryButton, useScheme } from '../ui';
import { useProduct, useProductQuery } from '../product-store';
import { SettingsGroup, SettingsRow } from './rows';
import { SampleDisabledScreen } from '../sample/disabled-screen';
import { useSettingsActivity } from './use-settings-activity';

const STATUS_LABELS: Record<SyncStatus, string> = {
  idle: 'Off',
  syncing: 'Syncing…',
  up_to_date: 'Up to Date',
  offline: 'Offline',
  signed_out: 'Signed Out',
  needs_attention: 'Needs Attention',
};

// the toggle explains where the data goes before it turns on, then shows
// the engine's own status. raw provider errors never reach this screen.
export function ICloudScreen() {
  const { scope } = useProduct();
  if (scope.kind === 'sample') return <SampleDisabledScreen title="iCloud Sync" message="iCloud Sync is disabled in sample mode." />;
  return <ICloudBody />;
}

function ICloudBody() {
  const scheme = useScheme();
  const { scope, invalidate, nextCommandId, sync: syncState, syncNow, pauseSync, resumeSync } = useProduct();
  const activity = useSettingsActivity(scope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const summary = useProductQuery((c) => getSyncSummary(c), []);
  const { status, busy } = syncState;
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!activity.active) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled || !activity.active) return;
      void scope.run(({ effects }) => {
        if (effects.kind !== 'real') throw new Error('iCloud Sync is disabled in sample mode.');
        return effects.cloudKitAvailable();
      }).then(
        dispatch => { if (!cancelled && activity.active && dispatch.started) setAvailable(dispatch.value); },
        () => { if (!cancelled && activity.active) setAvailable(false); },
      );
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => { cancelled = true; subscription.remove(); };
  }, [status, scope, activity]);
  const ready = summary.status === 'ready' ? summary.value : null;
  const summaryPlaceholder = summary.status === 'error' ? 'Unavailable' : '…';
  const enabled = ready !== null && ready.enabled;

  const setEnabled = useCallback(
    (next: boolean) => {
      if (!activity.active) return;
      const apply = () => {
        if (!activity.active || !mounted.current) return;
        setError(null);
        if (!next) {
          // stop before the write, so nothing in flight can outlive the
          // moment the person turned sync off
          pauseSync();
        }
        void scope.run(({ core }) => setICloudSyncEnabled(core, { commandId: nextCommandId(), enabled: next })).then(
          dispatch => {
            if (!dispatch.started) return;
            const result = dispatch.value;
            if (result.ok) { invalidate(); resumeSync(); }
            else {
              if (activity.active) setError(result.error.message);
              if (!next) resumeSync();
            }
          },
          () => {
            if (activity.active) setError('Sync settings could not be saved. Try again.');
            if (!next) resumeSync();
          },
        );
      };
      if (!next) {
        apply();
        return;
      }
      Alert.alert(
        'Turn on iCloud Sync?',
        'Your boards, check-ins, notes, and reminders are stored in your own private iCloud account. Nothing is sent anywhere else.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Turn On', onPress: apply },
        ],
      );
    },
    [scope, activity, invalidate, nextCommandId, pauseSync, resumeSync],
  );

  const pending = ready === null ? summaryPlaceholder : String(ready.pendingChanges);
  const lastSuccess = ready === null ? null : ready.lastSuccessAtUtc;

  return (
    <View style={{ flex: 1, backgroundColor: semanticColor('groupedBackground', scheme) }}>
      <Stack.Screen options={{ title: 'iCloud Sync' }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
            backgroundColor: semanticColor('secondaryGroupedBackground', scheme),
            borderRadius: radius.lg,
            borderCurve: radiusCurve,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
          }}
        >
          <AppText style={{ flex: 1 }}>iCloud Sync</AppText>
          <Switch
            accessibilityLabel="iCloud Sync"
            value={enabled}
            disabled={ready === null}
            accessibilityState={{ disabled: ready === null }}
            onValueChange={setEnabled}
            testID="icloud-toggle"
          />
        </View>

        {summary.status === 'error' ? (
          <View style={{ gap: spacing.md }}>
            <InlineError message="Sync information could not be loaded." testID="icloud-summary-error" />
            <PrimaryButton title="Retry" onPress={() => { if (activity.active) summary.refresh(); }} testID="icloud-summary-retry" />
          </View>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            title="Status"
            detail={ready === null ? summaryPlaceholder : enabled ? STATUS_LABELS[status] : 'Off'}
            testID="icloud-status"
          />
          <SettingsRow title="Waiting to upload" detail={pending} testID="icloud-pending" />
          <SettingsRow
            title="Last sync"
            detail={
              ready === null ? summaryPlaceholder : lastSuccess === null
                ? 'Never'
                : new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(lastSuccess))
            }
            testID="icloud-last-sync"
          />
        </SettingsGroup>

        <SettingsGroup title="Incoming data on this device">
          <SettingsRow
            title="Waiting for related data"
            detail={ready === null ? summaryPlaceholder : String(ready.incoming.pending)}
            testID="icloud-incoming-pending"
          />
          <SettingsRow
            title="At processing limit"
            detail={ready === null ? summaryPlaceholder : String(ready.incoming.blocked)}
            testID="icloud-incoming-blocked"
          />
          <SettingsRow
            title="Conflicting or invalid data"
            detail={ready === null ? summaryPlaceholder : String(ready.incoming.quarantined)}
            testID="icloud-incoming-quarantined"
          />
        </SettingsGroup>

        {enabled ? (
          <PrimaryButton
            title={busy ? 'Syncing…' : 'Sync Now'}
            onPress={() => { if (activity.active) syncNow(); }}
            disabled={busy}
            testID="icloud-sync-now"
          />
        ) : null}

        {error || syncState.error ? <InlineError message={error ?? syncState.error!} testID="icloud-error" /> : null}

        {available === false ? (
          <AppText variant="footnote" testID="icloud-unavailable">
            iCloud is unavailable on this device right now. Your changes stay queued, and Export
            Data always gives you a portable copy.
            {' '}If you changed iCloud accounts, sign back into the account originally used for
            sync on this device.
          </AppText>
        ) : null}
        <AppText variant="footnote">
          Local use never depends on iCloud. Turning sync off keeps all of your data on this
          device.
        </AppText>
      </ScrollView>
    </View>
  );
}
