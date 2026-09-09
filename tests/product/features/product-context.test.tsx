import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { err, ok, type DomainResult } from '@/core/domain/result';
import { ProductContext, useProductQuery, type ProductContextValue } from '@/features/product-store/context';
import { INITIAL_SYNC } from '@/features/product-store/sync-coordinator';
import type { ProductCore } from '@/platform/database/product-core';
import { missAlertScheduler } from '@/testing/notifications-platform.mock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

describe('import-safe product context', () => {
  let harness: TestHarness;
  let context: ProductContextValue;
  beforeEach(async () => {
    harness = await createTestHarness();
    context = {
      core: harness.deps, version: 0, invalidate: jest.fn(), nextCommandId: () => harness.ids.nextCommandId(),
      sync: INITIAL_SYNC, syncNow: jest.fn(), pauseSync: jest.fn(), resumeSync: jest.fn(),
      missAlertScheduler, missAlertVersion: 0,
    };
  });
  afterEach(async () => { await harness.db.closeAsync(); });

  function Probe({ query }: { query: (core: ProductCore) => Promise<DomainResult<number>> }) {
    const result = useProductQuery(query, [query]);
    return <Text onPress={result.refresh}>{JSON.stringify(result)}</Text>;
  }

  it('retains successful and domain-error query outcomes and delegates refresh', async () => {
    const valid = async (core: ProductCore) => {
      const row = await core.db.getFirstAsync<{ count: number }>('SELECT count(*) AS count FROM boards');
      return ok(row!.count);
    };
    const view = render(<ProductContext.Provider value={context}><Probe query={valid} /></ProductContext.Provider>);
    expect(screen.getByText('{"status":"loading"}')).toBeOnTheScreen();
    await act(async () => {});
    fireEvent.press(screen.getByText('{"status":"ready","value":0}'));
    expect(context.invalidate).toHaveBeenCalledTimes(1);
    const invalid = async () => err('not_found', 'No longer available.');
    view.rerender(<ProductContext.Provider value={context}><Probe query={invalid} /></ProductContext.Provider>);
    await act(async () => {});
    expect(screen.getByText('{"status":"error","error":{"code":"not_found","message":"No longer available.","retryable":false}}')).toBeOnTheScreen();
  });

  it('ignores a late ready result when the query identity has changed', async () => {
    let resolve!: (value: DomainResult<number>) => void;
    const old = () => new Promise<DomainResult<number>>(done => { resolve = done; });
    const current = async () => ok(2);
    const view = render(<ProductContext.Provider value={context}><Probe query={old} /></ProductContext.Provider>);
    view.rerender(<ProductContext.Provider value={context}><Probe query={current} /></ProductContext.Provider>);
    await act(async () => {});
    await act(async () => { resolve(ok(1)); });
    expect(screen.getByText('{"status":"ready","value":2}')).toBeOnTheScreen();
  });

  it('maps Error rejection and ignores a retired rejected query', async () => {
    let reject!: (cause: unknown) => void;
    const old = () => new Promise<DomainResult<number>>((_, fail) => { reject = fail; });
    const failed = async () => { throw new Error('read failed'); };
    const view = render(<ProductContext.Provider value={context}><Probe query={old} /></ProductContext.Provider>);
    view.rerender(<ProductContext.Provider value={context}><Probe query={failed} /></ProductContext.Provider>);
    await act(async () => {});
    await act(async () => { reject(new Error('obsolete failure')); });
    expect(screen.getByText('{"status":"error","error":{"code":"database","message":"read failed","retryable":true}}')).toBeOnTheScreen();
  });
});
