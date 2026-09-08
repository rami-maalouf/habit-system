import { useCallback, useEffect, useRef, useState } from 'react';

import { getCoinHistoryPage } from '@/core/domain/coin-queries';
import type { CoinHistoryCursor, CoinHistoryItem } from '@/core/domain/coin-queries';
import type { DomainError } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';

import { useProduct } from '../product-store';

type PageState = {
  status: 'loading' | 'ready' | 'error';
  items: CoinHistoryItem[];
  loadingMore: boolean;
  error: DomainError | null;
  moreError: DomainError | null;
};
type RequestOwner = {
  core: ProductCore;
  active: boolean;
  loading: boolean;
  cursor: CoinHistoryCursor | null;
  items: CoinHistoryItem[];
};

export function useCoinHistory() {
  const { core, version } = useProduct();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<PageState>({ status: 'loading', items: [], loadingMore: false, error: null, moreError: null });
  const ownerRef = useRef<RequestOwner | null>(null);

  const load = useCallback((owner: RequestOwner, first: boolean) => {
    if (!owner.active || owner.loading || (!first && owner.cursor === null)) return;
    owner.loading = true;
    void getCoinHistoryPage(owner.core, owner.cursor ? { before: owner.cursor } : {}).then(result => {
      if (!owner.active) return;
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
      if (!owner.active) return;
      const error: DomainError = { code: 'database', message: cause instanceof Error ? cause.message : String(cause), retryable: true };
      setState(current => first ? { ...current, status: 'error', error }
        : { ...current, loadingMore: false, moreError: error });
    }).finally(() => {
      // a retired request can release only its own guard, never a newer page's.
      owner.loading = false;
    });
  }, []);

  useEffect(() => {
    const owner: RequestOwner = { core, active: true, loading: false, cursor: null, items: [] };
    ownerRef.current = owner;
    void load(owner, true);
    return () => { owner.active = false; };
  }, [core, version, refreshVersion, load]);

  const refresh = useCallback(() => {
    if (ownerRef.current) ownerRef.current.active = false;
    setState(current => ({ ...current, status: 'loading', loadingMore: false, error: null, moreError: null }));
    setRefreshVersion(value => value + 1);
  }, []);
  const loadMore = useCallback(() => {
    const owner = ownerRef.current;
    if (owner?.active && !owner.loading && owner.cursor !== null) {
      setState(current => ({ ...current, loadingMore: true, moreError: null }));
      void load(owner, false);
    }
  }, [load]);
  return { ...state, refresh, loadMore };
}
