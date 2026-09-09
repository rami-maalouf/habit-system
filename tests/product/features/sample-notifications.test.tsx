import { cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { Text } from 'react-native';

import NotificationsRoute from '@/app/settings/notifications';
import * as queries from '@/core/domain/queries';
import * as missAlerts from '@/core/domain/miss-alert-reconciliation';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner } from '@/features/product-store/operation-scope';
import { renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness } from '../helpers/test-db';

it('keeps a direct sample Notifications route disabled before permission, count or SQL work', async () => {
  const harness = await createTestHarness();
  const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
  const permission = jest.spyOn(Notifications, 'getPermissionsAsync');
  const overview = jest.spyOn(queries, 'getNotificationOverview');
  const count = jest.spyOn(missAlerts, 'getPendingMissAlertCount');
  const all = jest.spyOn(harness.db, 'getAllAsync');
  const first = jest.spyOn(harness.db, 'getFirstAsync');
  const write = jest.spyOn(harness.db, 'runAsync');
  function Root() {
    return <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider></ThemeProvider>;
  }
  try {
    renderRouter({ _layout: Root, index: () => <Text>Sample home</Text>,
      'settings/notifications': NotificationsRoute }, { initialUrl: '/settings/notifications' });
    await settle();
    expect(screen.getByText('Notifications are disabled in sample mode.')).toBeOnTheScreen();
    expect(screen).toHavePathname('/settings/notifications');
    expect(screen.queryByTestId('notifications-status')).toBeNull();
    expect(screen.queryByTestId('notifications-miss-count')).toBeNull();
    expect(screen.queryByTestId('notifications-open-settings')).toBeNull();
    expect(permission).not.toHaveBeenCalled();
    expect(overview).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    cleanup();
    jest.restoreAllMocks();
    await owner.suspend();
    await harness.db.closeAsync();
  }
});
