import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StrictMode, useEffect } from 'react';
import { Text } from 'react-native';

import { ProductProvider, useProduct } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { useProductActivity, type ProductActivity } from '@/features/product-store/use-product-activity';
import { renderRouter, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('real notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('real widgets evaluated'); });

describe('product per-focus authority', () => {
  let h: TestHarness, owner: OperationOwner, latest: ProductActivity;
  const effects = new Set<ProductActivity>();
  const rendered: ProductActivity[] = [];
  beforeEach(async () => { h = await createTestHarness(); owner = createOperationOwner(h.deps, { kind: 'sample-disabled' }); effects.clear(); rendered.length = 0; });
  afterEach(async () => { cleanup(); await owner.suspend(); await h.db.closeAsync(); });
  function Probe() {
    const { scope } = useProduct();
    const activity = useProductActivity(scope);
    latest = activity; rendered.push(activity);
    useEffect(() => {
      if (!activity.active) return;
      effects.add(activity); return () => { effects.delete(activity); };
    }, [activity]);
    return <Text>{activity.active ? 'Active product scene' : 'Inactive product scene'}</Text>;
  }

  it.each([false, true])('retires captured authority and cleans effect owners on cover, resume and removal (StrictMode: %s)', async strict => {
    function Root() {
      const content = <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider></ThemeProvider>;
      return strict ? <StrictMode>{content}</StrictMode> : content;
    }
    renderRouter({ _layout: Root, index: Probe, cover: () => <Text>Cover</Text> }, { initialUrl: '/' }); await settle();
    const original = latest, originalScope = owner.getScope();
    expect(original.active).toBe(true); expect(Object.isFrozen(original)).toBe(true); expect(effects).toEqual(new Set([original]));
    const beforeCover = rendered.length;
    act(() => router.push('/cover')); await settle();
    expect(owner.getScope()).toBe(originalScope); expect(original.active).toBe(false); expect(effects.size).toBe(0);
    expect(rendered.slice(beforeCover).some(activity => activity !== original && !activity.active)).toBe(true);
    act(() => router.back()); await settle();
    const returned = latest;
    expect(returned).not.toBe(original); expect(returned.active).toBe(true); expect(original.active).toBe(false);
    expect(effects).toEqual(new Set([returned]));
    await act(async () => { await owner.suspend(); }); await settle();
    expect(returned.active).toBe(false); expect(latest.active).toBe(false); expect(effects.size).toBe(0);
    act(() => owner.resume()); await settle();
    const resumed = latest;
    expect(resumed.active).toBe(true); expect(resumed).not.toBe(returned); expect(returned.active).toBe(false);
    act(() => router.replace('/cover')); await settle();
    expect(resumed.active).toBe(false); expect(effects.size).toBe(0);
  });
});
