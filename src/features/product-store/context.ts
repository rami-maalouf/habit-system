import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import type { CommandId } from '@/core/domain/ids';
import type { MissAlertScheduler, ReminderScheduler } from '@/core/domain/ports';
import type { DomainError, DomainResult } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';
import type { pickImportFile, saveAndShareExport } from '@/platform/data-transfer';
import type { supportsAlternateIcons, setAlternateIcon } from '@/platform/alternate-icons';
import type { cloudKitAvailable } from '@/platform/sync';

import type { SyncSnapshot } from './sync-coordinator';

export type ProductDispatch<Value> = { started: false } | { started: true; value: Value };

export type FeatureEffects = Readonly<
  | { kind: 'sample-disabled' }
  | {
    kind: 'real';
    reminders: ReminderScheduler;
    missAlerts: MissAlertScheduler;
    cloudKitAvailable: typeof cloudKitAvailable;
    pickImportFile: typeof pickImportFile;
    saveAndShareExport: typeof saveAndShareExport;
    supportsAlternateIcons: typeof supportsAlternateIcons;
    setAlternateIcon: typeof setAlternateIcon;
    openSystemSettings(): Promise<void>;
    openReleaseLink(url: string, inApp: boolean): Promise<void>;
  }
>;

export type ProductScope = Readonly<{
  kind: 'real' | 'sample';
  active: boolean;
  isCurrent(): boolean;
  run<Value>(work: (accepted: { core: ProductCore; effects: FeatureEffects }) => Promise<Value>): Promise<ProductDispatch<Value>>;
}>;

export type ProductContextValue = {
  core: ProductCore;
  scope: ProductScope;
  closeSample: (() => Promise<void>) | null;
  version: number;
  invalidate: () => void;
  nextCommandId: () => CommandId;
  sync: SyncSnapshot;
  syncNow: () => void;
  pauseSync: () => void;
  resumeSync: () => void;
  missAlertScheduler: MissAlertScheduler | null;
  missAlertVersion: number;
};

export const ProductContext = createContext<ProductContextValue | null>(null);

export function useProduct(): ProductContextValue {
  const context = useContext(ProductContext);
  if (!context) {
    throw new Error('useProduct requires a ProductProvider');
  }
  return context;
}

export type QueryState<Value> =
  | { status: 'loading' }
  | { status: 'error'; error: DomainError }
  | { status: 'ready'; value: Value };

// re-runs the query whenever a command invalidates the store
export function useProductQuery<Value>(
  run: (core: ProductCore) => Promise<DomainResult<Value>>,
  dependencies: readonly unknown[],
): QueryState<Value> & { refresh: () => void } {
  const { core, scope, version, invalidate } = useProduct();
  const [state, setState] = useState<QueryState<Value>>({ status: 'loading' });

  useEffect(() => {
    if (!scope.isCurrent()) return;
    let cancelled = false;
    scope.run(({ core: accepted }) => run(accepted)).then(
      (dispatch) => {
        if (cancelled || !scope.isCurrent() || !dispatch.started) {
          return;
        }
        const result = dispatch.value;
        setState(result.ok ? { status: 'ready', value: result.value } : { status: 'error', error: result.error });
      },
      (cause: unknown) => {
        if (!cancelled && scope.isCurrent()) {
          setState({
            status: 'error',
            error: {
              code: 'database',
              message: cause instanceof Error ? cause.message : String(cause),
              retryable: true,
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run is inline; identity tracked via dependencies
  }, [core, scope, version, ...dependencies]);

  const refresh = useCallback(() => { if (scope.isCurrent()) invalidate(); }, [scope, invalidate]);
  return { ...state, refresh };
}
