import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DomainResult } from '@/core/domain/result';
import { err, ok } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';

import { useProduct, useProductQuery } from '../product-store';

type TimedSnapshot = { generatedAtUtc: number; refreshAtUtc: number | null };
const RETRY_MS = 30_000;

// reuse query cancellation and preserve ready data during local refreshes.
// request metadata prevents retained data from arming an obsolete timer.
export function useStackSnapshot<Value extends TimedSnapshot>(
  run: (core: ProductCore) => Promise<DomainResult<Value>>,
  key: string,
) {
  const { core, scope, version } = useProduct();
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => { if (scope.isCurrent()) setAttempt(value => value + 1); }, [scope]);
  const currentRequest = useRef<object | null>(null);
  const request = useMemo(() => ({ key, version, attempt, scope }), [key, version, attempt, scope]);
  useEffect(() => {
    if (!scope.isCurrent()) return;
    currentRequest.current = request;
    return () => { currentRequest.current = null; };
  }, [request, scope]);
  const state = useProductQuery(async (deps) => {
    let result = await run(deps);
    const expired = (value: Value) => value.refreshAtUtc !== null && value.refreshAtUtc <= deps.clock.nowUtcMs();
    // one immediate reread handles a boundary crossed in flight; repeated
    // expired responses use the same bounded retry as a transient failure.
    if (result.ok && expired(result.value) && scope.isCurrent() && currentRequest.current === request) result = await run(deps);
    if (result.ok && expired(result.value)) return err('database', 'Stack information changed while loading. Try again.', { retryable: true });
    return result.ok ? ok({ snapshot: result.value, request }) : result;
  }, [key, attempt]);
  const ready = state.status === 'ready' ? state.value : null;
  const failure = state.status === 'error' ? state.error : null;
  useEffect(() => {
    if (!scope.isCurrent()) return;
    let delay: number;
    if (failure?.retryable) delay = RETRY_MS;
    else if (ready?.request === request && ready.snapshot.refreshAtUtc !== null) {
      delay = Math.max(1, ready.snapshot.refreshAtUtc - core.clock.nowUtcMs());
    } else return;
    const timer = setTimeout(() => {
      if (scope.isCurrent() && currentRequest.current === request) refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [core, scope, failure, ready, refresh, request]);
  return state.status === 'ready'
    ? { status: 'ready' as const, value: state.value.snapshot, refresh }
    : { ...state, refresh };
}
