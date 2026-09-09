import * as Application from 'expo-application';
import { getLocales } from 'expo-localization';

import type { ExportMeta } from '@/core/export/serialize';
import { latestSchemaVersion } from '@/core/persistence/schema';

export function getExportMeta(): ExportMeta {
  return {
    databaseSchemaVersion: latestSchemaVersion,
    appVersion: Application.nativeApplicationVersion ?? 'development',
    buildVersion: Application.nativeBuildVersion ?? 'development',
    locale: getLocales()[0]?.languageTag ?? 'en-US',
  };
}
