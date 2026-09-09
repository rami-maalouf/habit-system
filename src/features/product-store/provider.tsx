import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';

import type { CommandId } from '@/core/domain/ids';
import type { MissAlertScheduler } from '@/core/domain/ports';
import type { SyncTransport, WireSyncRecord } from '@/core/sync/transport';
import type { ProductCore } from '@/platform/database/product-core';

import { ProductContext, type ProductContextValue } from './context';
import type { OperationOwner } from './operation-scope';
import { useSampleSnapshot } from '../sample/session-context';

export { useProduct, useProductQuery } from './context';
export type { QueryState } from './context';

export type RealProductProviderProps = {
  children: ReactNode;
  coreOverride?: ProductCore;
  syncTransportOverride?: SyncTransport<WireSyncRecord>;
  // selected for initial leased effects; later replacement affects only
  // the existing notification coordinator and pending-count observer.
  missAlertSchedulerOverride?: MissAlertScheduler;
};

export type SampleProductProviderProps = {
  children: ReactNode;
  owner: OperationOwner;
  closeSample: () => Promise<void>;
};

export function ProductProvider(props: RealProductProviderProps | SampleProductProviderProps) {
  if ('owner' in props) return <SampleProductProvider {...props} />;
  return <RealProviderBoundary {...props} />;
}

function RealProviderBoundary(props: RealProductProviderProps) {
  const snapshot = useSampleSnapshot();
  const [mounted, setMounted] = useState(snapshot.status === 'idle');
  // covered real scenes retain their provider; cold sample entry opens none.
  if (!mounted && snapshot.status === 'idle') setMounted(true);
  if (!mounted) return <View testID="product-suspended" />;
  // evaluate native constructors only when a real runtime is requested.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RealProductProvider } = require('./real-runtime') as typeof import('./real-runtime');
  return <RealProductProvider {...props} />;
}

function unavailable(): never {
  throw new Error('This action is unavailable in sample mode.');
}

function SampleProductProvider({ owner, closeSample, children }: SampleProductProviderProps) {
  const scope = useSyncExternalStore(owner.subscribe, owner.getScope, owner.getScope);
  const [version, setVersion] = useState(0);
  const invalidate = useCallback(() => {
    if (scope.isCurrent()) setVersion(value => value + 1);
  }, [scope]);
  const value = useMemo<ProductContextValue>(() => ({
    core: owner.core, scope, closeSample, version, invalidate,
    nextCommandId: () => {
      if (!scope.isCurrent()) throw new Error('The product scope is inactive.');
      return owner.core.ids.uuid() as CommandId;
    },
    sync: { status: 'idle', busy: false, error: null },
    syncNow: unavailable, pauseSync: unavailable, resumeSync: unavailable,
    missAlertScheduler: null, missAlertVersion: 0,
  }), [owner, scope, closeSample, version, invalidate]);
  if (scope.kind !== 'sample') throw new Error('A sample provider requires a sample operation owner.');
  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}
