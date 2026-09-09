import type { ProductCore } from '@/platform/database/product-core';

import type { FeatureEffects, ProductScope } from './context';

export type OperationOwner = Readonly<{
  core: ProductCore;
  getScope(): ProductScope;
  subscribe(listener: () => void): () => void;
  suspend(): Promise<void>;
  resume(): void;
}>;

export function createOperationOwner(rawCore: ProductCore, sourceEffects: FeatureEffects): OperationOwner {
  const effects = Object.freeze({ ...sourceEffects });
  const pending = new Set<Promise<unknown>>();
  const listeners = new Set<() => void>();
  let joining: Promise<void> | null = null;
  let draining = false;

  function track<Value>(work: () => Promise<Value>): Promise<Value> {
    let start!: () => void;
    const result = new Promise<Value>((resolve, reject) => {
      start = () => {
        try { resolve(work()); } catch (cause) { reject(cause); }
      };
    });
    pending.add(result);
    void result.then(() => { pending.delete(result); }, () => { pending.delete(result); });
    start();
    return result;
  }

  function makeScope(active: boolean): ProductScope {
    const captured: ProductScope = Object.freeze({
      kind: effects.kind === 'real' ? 'real' : 'sample',
      active,
      isCurrent: () => active && scope === captured,
      run: async work => {
        if (!captured.isCurrent()) return { started: false };
        const value = await track(() => work({ core: rawCore, effects }));
        return { started: true, value };
      },
    });
    return captured;
  }

  let scope = makeScope(true);
  function access<Value>(work: () => Promise<Value>): Promise<Value> {
    if (!scope.active) return Promise.reject(new Error('The product scope is inactive.'));
    return track(work);
  }

  // accepted transactions retain their acquired executor through completion.
  const db = Object.freeze<ProductCore['db']>({
    runAsync: (sql, params) => access(() => rawCore.db.runAsync(sql, params)),
    getAllAsync: (sql, params) => access(() => rawCore.db.getAllAsync(sql, params)),
    getFirstAsync: (sql, params) => access(() => rawCore.db.getFirstAsync(sql, params)),
    execAsync: sql => access(() => rawCore.db.execAsync(sql)),
    withExclusiveTransactionAsync: work => access(() => rawCore.db.withExclusiveTransactionAsync(work)),
    withTransactionAsync: work => access(() => rawCore.db.withTransactionAsync(work)),
    closeAsync: () => Promise.reject(new Error('The product database is owned by its runtime.')),
  });
  const core: ProductCore = Object.freeze({ ...rawCore, db });

  return Object.freeze({
    core,
    getScope: () => scope,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    suspend: () => {
      if (!scope.active) return joining!;
      scope = makeScope(false);
      draining = true;
      joining = Promise.allSettled([...pending]).then(() => { draining = false; });
      for (const listener of listeners) listener();
      return joining;
    },
    resume: () => {
      if (scope.active) return;
      if (draining) throw new Error('Accepted product work is still running.');
      scope = makeScope(true);
      joining = null;
      for (const listener of listeners) listener();
    },
  });
}
