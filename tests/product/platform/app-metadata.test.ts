import * as Application from 'expo-application';
import * as Localization from 'expo-localization';

import { getExportMeta } from '@/platform/app-metadata';
import { latestSchemaVersion } from '@/core/persistence/schema';

jest.mock('expo-application', () => ({ __esModule: true, nativeApplicationVersion: 'test', nativeBuildVersion: 'test' }));
jest.mock('expo-file-system', () => { throw new Error('metadata evaluated file access'); });
jest.mock('expo-sharing', () => { throw new Error('metadata evaluated sharing'); });

it('reads actual application constants and locale without loading transfer effects', () => {
  jest.spyOn(Localization, 'getLocales').mockReturnValue([{ languageTag: 'fr-CA' } as Localization.Locale]);
  expect(getExportMeta()).toEqual({ databaseSchemaVersion: latestSchemaVersion, appVersion: 'test', buildVersion: 'test', locale: 'fr-CA' });
  jest.restoreAllMocks();
});

it('retains development and locale fallbacks when native metadata is absent', () => {
  const version = Object.getOwnPropertyDescriptor(Application, 'nativeApplicationVersion')!;
  const build = Object.getOwnPropertyDescriptor(Application, 'nativeBuildVersion')!;
  Object.defineProperty(Application, 'nativeApplicationVersion', { value: null, configurable: true });
  Object.defineProperty(Application, 'nativeBuildVersion', { value: null, configurable: true });
  jest.spyOn(Localization, 'getLocales').mockReturnValue([] as unknown as ReturnType<typeof Localization.getLocales>);
  try {
    expect(getExportMeta()).toEqual({ databaseSchemaVersion: latestSchemaVersion, appVersion: 'development', buildVersion: 'development', locale: 'en-US' });
  } finally {
    Object.defineProperty(Application, 'nativeApplicationVersion', version);
    Object.defineProperty(Application, 'nativeBuildVersion', build);
    jest.restoreAllMocks();
  }
});
