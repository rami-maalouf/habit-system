import { cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Text } from 'react-native';

import { ProductProvider } from '@/features/product-store';
import { createOperationOwner } from '@/features/product-store/operation-scope';
import { ExportScreen } from '@/features/settings/export-screen';
import { ImportScreen } from '@/features/settings/import-screen';
import { AppIconScreen } from '@/features/settings/app-icon-screen';
import { ICloudScreen } from '@/features/settings/icloud-screen';
import { NotificationsScreen } from '@/features/settings/notifications-screen';
import { renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/data-transfer', () => { throw new Error('native file/sharing adapter evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('native notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('native widgets evaluated'); });
jest.mock('@/platform/alternate-icons', () => { throw new Error('native icon adapter evaluated'); });
jest.mock('@/platform/sync', () => { throw new Error('native account adapter evaluated'); });
jest.mock('expo-notifications', () => { throw new Error('native permission adapter evaluated'); });

it.each([
  ['import', ImportScreen, 'Import is disabled in sample mode.'],
  ['export', ExportScreen, 'Export is disabled in sample mode.'],
  ['icons', AppIconScreen, 'App icons are disabled in sample mode.'],
  ['sync', ICloudScreen, 'iCloud Sync is disabled in sample mode.'],
  ['notifications', NotificationsScreen, 'Notifications are disabled in sample mode.'],
] as const)('keeps direct sample %s disabled before mounting its real body', async (name, Screen, message) => {
  const harness = await createTestHarness();
  const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
  const reads = jest.spyOn(harness.db, 'getAllAsync');
  const first = jest.spyOn(harness.db, 'getFirstAsync');
  const writes = jest.spyOn(harness.db, 'runAsync');
  function Root() {
    return <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider></ThemeProvider>;
  }
  try {
    renderRouter({ _layout: Root, index: () => <Text>Sample home</Text>, [name]: Screen }, { initialUrl: `/${name}` });
    await settle();
    expect(screen.getByText(message)).toBeOnTheScreen();
    expect(screen.queryByTestId('import-own')).toBeNull();
    expect(screen.queryByTestId('export-start')).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  } finally {
    cleanup(); jest.restoreAllMocks(); await owner.suspend(); await harness.db.closeAsync();
  }
});
