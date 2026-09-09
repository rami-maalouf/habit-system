import { useCallback, useEffect, useRef, useState } from 'react';

import { getCoinHistoryPage } from '@/core/domain/coin-queries';
import type { CoinHistoryCursor, CoinHistoryItem } from '@/core/domain/coin-queries';
import type { DomainError } from '@/core/domain/result';

import { useProduct } from '../product-store';
import type { ProductScope } from '../product-store/context';

type PageState = {
  status: 'loading' | 'ready' | 'error';
  items: CoinHistoryItem[];
  loadingMore: boolean;
  error: DomainError | null;
  moreError: DomainError | null;
};
type RequestOwner = {
  scope: ProductScope;
  active: boolean;
  loading: boolean;
  cursor: CoinHistoryCursor | null;
  items: CoinHistoryItem[];
};

export function useCoinHistory() {
  const { core, scope, version } = useProduct();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<PageState>({ status: 'loading', items: [], loadingMore: false, error: null, moreError: null });
  const ownerRef = useRef<RequestOwner | null>(null);

  const load = useCallback((owner: RequestOwner, first: boolean) => {
    if (!owner.active || !owner.scope.isCurrent() || owner.loading || (!first && owner.cursor === null)) return;
    owner.loading = true;
    void owner.scope.run(({ core: accepted }) => getCoinHistoryPage(accepted, owner.cursor ? { before: owner.cursor } : {})).then(dispatch => {
      if (!owner.active || !owner.scope.isCurrent() || !dispatch.started) return;
      const result = dispatch.value;
      if (!result.ok) {
        setState(current => first ? { ...current, status: 'error', error: result.error }
          : { ...current, loadingMore: false, moreError: result.error });
        return;
      }
      const unique = new Map(owner.items.map(item => [item.id, item]));
      for (const item of result.value.items) unique.set(item.id, item);
      owner.items = [...unique.values()];
      owner.cursor = result.value.nextCursor;
      setState({ status: 'ready', items: owner.items, loadingMore: false, error: null, moreError: null });
    }, (cause: unknown) => {
      if (!owner.active || !owner.scope.isCurrent()) return;
      const error: DomainError = { code: 'database', message: cause instanceof Error ? cause.message : String(cause), retryable: true };
      setState(current => first ? { ...current, status: 'error', error }
        : { ...current, loadingMore: false, moreError: error });
    }).finally(() => {
      // a retired request can release only its own guard, never a newer page's.
      owner.loading = false;
    });
  }, []);

  useEffect(() => {
    if (!scope.isCurrent()) return;
    const owner: RequestOwner = { scope, active: true, loading: false, cursor: null, items: [] };
    ownerRef.current = owner;
    void load(owner, true);
    return () => { owner.active = false; };
  }, [core, scope, version, refreshVersion, load]);

  const refresh = useCallback(() => {
    if (!scope.isCurrent()) return;
    if (ownerRef.current) ownerRef.current.active = false;
    setState(current => ({ ...current, status: 'loading', loadingMore: false, error: null, moreError: null }));
    setRefreshVersion(value => value + 1);
  }, [scope]);
  const loadMore = useCallback(() => {
    if (!scope.isCurrent()) return;
    const owner = ownerRef.current;
    if (owner?.active && !owner.loading && owner.cursor !== null) {
      setState(current => ({ ...current, loadingMore: true, moreError: null }));
      void load(owner, false);
    }
  }, [load, scope]);
  return { ...state, refresh, loadMore };
}
