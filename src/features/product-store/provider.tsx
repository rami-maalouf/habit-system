import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { createCheckIn } from '@/core/domain/commands';
import type { CommandId } from '@/core/domain/ids';
import { parseBoardId } from '@/core/domain/ids';
import { getBoard } from '@/core/domain/queries';
import { refreshWidgetProjection } from '@/core/domain/widget-projection';
import type { MissAlertScheduler } from '@/core/domain/ports';
import type { DomainError, DomainResult } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';
import { getProductCore } from '@/platform/database/product-core';
import {
  addNotificationDestinationListener,
  addNotificationDeliveryListener,
  getInitialNotificationDestination,
  missAlertScheduler,
  reminderScheduler,
} from '@/platform/notifications';
import { addWidgetQuickActionListener, refreshWidgets } from '@/platform/widgets';
import { addSignificantTimeChangeListener } from '@/platform/time-change';
import { spacing } from '@/theme';
import { cloudKitTransport } from '@/platform/sync';
import type { SyncTransport, WireSyncRecord } from '@/core/sync/transport';

import { INITIAL_SYNC, SyncCoordinator, type SyncSnapshot } from './sync-coordinator';
import { NotificationCoordinator } from './notification-coordinator';

type ProductContextValue = {
  core: ProductCore;
  version: number;
  invalidate: () => void;
  nextCommandId: () => CommandId;
  sync: SyncSnapshot;
  syncNow: () => void;
  pauseSync: () => void;
  resumeSync: () => void;
  missAlertScheduler: MissAlertScheduler;
  missAlertVersion: number;
};

const ProductContext = createContext<ProductContextValue | null>(null);

type ProviderState =
  | { status: 'loading' }
  | { status: 'ready'; core: ProductCore }
  | { status: 'error'; error: DomainError };

type ProductProviderProps = {
  children: ReactNode;
  // tests inject a core over the in-memory engine; the app resolves the
  // shared sqlite core
  coreOverride?: ProductCore;
  syncTransportOverride?: SyncTransport<WireSyncRecord>;
  missAlertSchedulerOverride?: MissAlertScheduler;
};

export function ProductProvider({ children, coreOverride, syncTransportOverride, missAlertSchedulerOverride }: ProductProviderProps) {
  const [state, setState] = useState<ProviderState>(
    coreOverride ? { status: 'ready', core: coreOverride } : { status: 'loading' },
  );
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [sync, setSync] = useState(INITIAL_SYNC);
  const [missAlertVersion, setMissAlertVersion] = useState(0);
  const missScheduler = missAlertSchedulerOverride ?? missAlertScheduler;
  const notificationsRef = useRef<NotificationCoordinator | null>(null);
  const active = useRef(AppState.currentState === 'active');
  const projectionGeneration = useRef(0);
  const refreshQueries = useCallback(() => {
    projectionGeneration.current += 1;
    setVersion((current) => current + 1);
  }, []);
  const coordinatorRef = useRef<SyncCoordinator | null>(null);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const coordinator = new SyncCoordinator(state.core, syncTransportOverride ?? cloudKitTransport, setSync, refreshQueries);
    coordinatorRef.current = coordinator;
    void coordinator.request();
    return () => {
      coordinator.dispose();
      coordinatorRef.current = null;
    };
  }, [state, refreshQueries, syncTransportOverride]);

  const syncNow = useCallback(() => { void coordinatorRef.current?.request(); }, []);
  const pauseSync = useCallback(() => { coordinatorRef.current?.pause(); }, []);
  const resumeSync = useCallback(() => { coordinatorRef.current?.resume(); }, []);

  useEffect(() => {
    if (coreOverride) {
      return;
    }
    let cancelled = false;
    getProductCore().then(
      (result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setState({ status: 'ready', core: result.value });
        } else {
          setState({ status: 'error', error: result.error });
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
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
  }, [coreOverride, attempt]);

  const invalidate = useCallback(() => {
    refreshQueries();
    syncNow();
  }, [refreshQueries, syncNow]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const coordinator = new NotificationCoordinator(state.core, missScheduler, reminderScheduler,
      active.current, () => setMissAlertVersion(value => value + 1), invalidate);
    notificationsRef.current = coordinator;
    return () => { coordinator.dispose(); notificationsRef.current = null; };
  }, [state, missScheduler, invalidate]);

  // miss-only progress has its own observer revision and cannot trigger this effect.
  useEffect(() => { notificationsRef.current?.request(); }, [state, version, missScheduler]);

  useEffect(() => {
    let current = true;
    const remove = addNotificationDeliveryListener(() => {
      if (current) setMissAlertVersion(value => value + 1);
    });
    return () => { current = false; remove(); };
  }, []);

  // native clock changes invalidate queries and rearm the day-boundary timer.
  // the existing version effect performs one reconciliation for the event.
  useEffect(() => addSignificantTimeChangeListener(invalidate), [invalidate]);

  // cache refresh, publication, and foreground expiry share one snapshot.
  // generation changes invalidate late results before their effects can commit.
  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    const core = state.core;
    const generation = projectionGeneration.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !cancelled && generation === projectionGeneration.current;
    const retry = () => {
      // retain the stale timeline and retry at a bounded rate while foregrounded.
      if (isCurrent()) timer = setTimeout(invalidate, 30_000);
    };
    void refreshWidgetProjection(core).then((result) => {
      if (!isCurrent()) return;
      if (!result.ok) { retry(); return; }
      const delay = result.value.expiresAtUtc - core.clock.nowUtcMs();
      if (delay > 0) void refreshWidgets(result.value);
      timer = setTimeout(invalidate, Math.max(0, delay));
    }).catch(retry);
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [invalidate, state, version]);

  // out-of-process writers (widgets, automations, sync) mutate the same
  // database; returning to the foreground refreshes every mounted query.
  // the in-process database-change hook lands with the widget stage.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (appState) => {
      active.current = appState === 'active';
      notificationsRef.current?.setActive(active.current);
      if (appState === 'active') {
        invalidate();
      }
    });
    return () => subscription?.remove?.();
  }, [invalidate]);

  // daily events open explicit fresh-state actions; count events retain
  // their existing quick-create behavior and form fallback.
  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    const core = state.core;
    let cancelled = false;
    const remove = addWidgetQuickActionListener((value) => {
      const boardId = parseBoardId(value);
      if (!boardId) return;
      void getBoard(core, boardId).then(async (board) => {
        if (cancelled) return;
        if (!board.ok || board.value.kind === 'daily') {
          router.navigate(`/boards/${boardId}/quick-action`);
          return;
        }
        const result = await createCheckIn(core, {
          commandId: core.ids.uuid() as CommandId, boardId, source: 'widget',
        });
        if (cancelled) return;
        if (result.ok) {
          invalidate();
        } else {
          router.navigate(`/boards/${boardId}/check-ins/new?source=widget`);
        }
      });
    });
    return () => { cancelled = true; remove(); };
  }, [invalidate, state]);

  // a tapped reminder deep-links to its board's add check-in sheet, both
  // while running and when the tap cold-started the app
  useEffect(() => {
    if (state.status !== 'ready') {
      return;
    }
    const open = ({ boardId, kind }: { boardId: string; kind: 'board' | 'new-check' }) => {
      if (!cancelled) router.push(kind === 'board' ? `/boards/${boardId}` : `/boards/${boardId}/check-ins/new`);
    };
    let cancelled = false;
    void getInitialNotificationDestination().then((destination) => {
      if (destination && !cancelled) {
        open(destination);
      }
    }).catch(() => {});
    const remove = addNotificationDestinationListener(open);
    return () => {
      cancelled = true;
      remove();
    };
  }, [state.status]);

  const value = useMemo<ProductContextValue | null>(() => {
    if (state.status !== 'ready') {
      return null;
    }
    return {
      core: state.core,
      version,
      invalidate,
      nextCommandId: () => state.core.ids.uuid() as CommandId,
      sync,
      syncNow,
      pauseSync,
      resumeSync,
      missAlertScheduler: missScheduler,
      missAlertVersion,
    };
  }, [state, version, invalidate, sync, syncNow, pauseSync, resumeSync, missScheduler, missAlertVersion]);

  if (state.status === 'loading') {
    return <View testID="product-loading" />;
  }

  if (state.status === 'error') {
    // a failed migration or open never creates a replacement database
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}
        testID="product-recovery"
      >
        <AppText variant="title2" accessibilityRole="header">
          Your data could not be opened
        </AppText>
        <AppText>{state.error.message}</AppText>
        <AppText
          accessibilityRole="button"
          onPress={() => {
            setState({ status: 'loading' });
            setAttempt((current) => current + 1);
          }}
          style={{ minHeight: 44 }}
        >
          Try again
        </AppText>
      </View>
    );
  }

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

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
  const { core, version, invalidate } = useProduct();
  const [state, setState] = useState<QueryState<Value>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    run(core).then(
      (result) => {
        if (cancelled) {
          return;
        }
        setState(result.ok ? { status: 'ready', value: result.value } : { status: 'error', error: result.error });
      },
      (cause: unknown) => {
        if (!cancelled) {
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
  }, [core, version, ...dependencies]);

  return { ...state, refresh: invalidate };
}
