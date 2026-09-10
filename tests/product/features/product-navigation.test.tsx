import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, useLocalSearchParams, type Href } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { Text } from 'react-native';

import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { ProductRedirect, productHref, useProductRouter } from '@/features/sample/navigation';
import { renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('real notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('real widgets evaluated'); });

describe('product navigation scope', () => {
  let harness: TestHarness;
  let owner: OperationOwner;
  let captured: ReturnType<typeof useProductRouter>;
  const close = jest.fn(async () => {});
  beforeEach(async () => {
    harness = await createTestHarness();
    owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    close.mockClear();
  });
  afterEach(async () => { cleanup(); await owner.suspend(); await harness.db.closeAsync(); });

  function Probe() {
    const current = useProductRouter();
    if (useIsFocused()) captured = current;
    const params = useLocalSearchParams();
    return <Text>{JSON.stringify(params)}</Text>;
  }
  function Root() { return <ThemeProvider value={DefaultTheme}><Stack /></ThemeProvider>; }
  function Sample() { return <ProductProvider owner={owner} closeSample={close}><Stack /></ProductProvider>; }
  const routes = {
    _layout: Root, index: () => <Text>Real home</Text>,
    'sample/_layout': Sample, 'sample/index': Probe, 'sample/boards/[boardId]': Probe,
    'sample/recover': () => <ProductRedirect href="/boards/recovered?source=recovery" />,
  };

  it('prefixes internal paths once while preserving dynamic and query parameters', () => {
    const target: Href = { pathname: '/boards/[boardId]', params: { boardId: 'one', source: 'widget', date: '2026-09-08' } };
    expect(productHref('real', target)).toBe(target);
    expect(productHref('real', '/')).toBe('/');
    expect(productHref('sample', '/')).toBe('/sample');
    expect(productHref('sample', '/?source=widget')).toBe('/sample?source=widget');
    expect(productHref('sample', '/boards/one?source=widget#history')).toBe('/sample/boards/one?source=widget#history');
    expect(productHref('sample', '/sample/boards/one?source=widget' as Href)).toBe('/sample/boards/one?source=widget');
    expect(productHref('sample', target)).toEqual({ ...target, pathname: '/sample/boards/[boardId]' });
    expect(() => productHref('sample', '../settings')).toThrow('absolute app path');
    expect(() => productHref('sample', '//outside.example')).toThrow('absolute app path');
    expect(() => productHref('sample', '/boards/../settings')).toThrow('absolute app path');
  });

  it.each(['push', 'navigate', 'replace'] as const)('keeps %s and dismissTo inside the sample navigator', async method => {
    renderRouter(routes, { initialUrl: '/sample' });
    await settle();
    act(() => captured[method]({ pathname: '/boards/[boardId]', params: { boardId: method, source: 'widget' } }));
    await settle();
    expect(screen).toHavePathname(`/sample/boards/${method}`);
    expect(screen.getByText(JSON.stringify({ boardId: method, source: 'widget' }))).toBeOnTheScreen();
    act(() => captured.dismissTo('/')); await settle();
    expect(screen).toHavePathname('/sample');
    expect(close).not.toHaveBeenCalled();
  });

  it('closes at the sample root without popping its real predecessor and backs within nested sample history', async () => {
    renderRouter(routes, { initialUrl: '/' });
    act(() => router.push('/sample' as Href)); await settle();
    act(() => captured.push('/boards/one')); await settle();
    act(() => captured.back()); await settle();
    expect(screen).toHavePathname('/sample');
    expect(close).not.toHaveBeenCalled();
    act(() => captured.back()); await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname('/sample');
  });

  it('recovers a cold nested route with no inner history to sample home instead of a parent route', async () => {
    renderRouter(routes, { initialUrl: '/sample/boards/cold' });
    await settle();
    act(() => captured.back()); await settle();
    expect(screen).toHavePathname('/sample');
    expect(close).not.toHaveBeenCalled();
  });

  it('denies captured navigation after pause and after the same core resumes', async () => {
    renderRouter(routes, { initialUrl: '/sample' }); await settle();
    const stale = captured;
    await act(async () => { await owner.suspend(); });
    for (const invoke of [() => stale.push('/boards/old'), () => stale.replace('/boards/old'),
      () => stale.navigate('/boards/old'), () => stale.dismissTo('/boards/old'), () => stale.back()]) {
      act(invoke); await settle();
      expect(screen).toHavePathname('/sample');
    }
    act(() => { owner.resume(); }); await settle();
    act(() => stale.push('/boards/old')); await settle();
    expect(screen).toHavePathname('/sample');
    expect(close).not.toHaveBeenCalled();
    act(() => captured.push('/boards/current')); await settle();
    expect(screen).toHavePathname('/sample/boards/current');
  });

  it('scopes a mounted recovery redirect and keeps its query parameter', async () => {
    renderRouter(routes, { initialUrl: '/sample/recover' }); await settle();
    expect(screen).toHavePathname('/sample/boards/recovered');
    expect(screen.getByText(JSON.stringify({ boardId: 'recovered', source: 'recovery' }))).toBeOnTheScreen();
  });

  it('keeps an inactive recovery route in place and redirects only through its fresh resumed scope', async () => {
    await owner.suspend();
    renderRouter(routes, { initialUrl: '/sample/recover' }); await settle();
    expect(screen).toHavePathname('/sample/recover');
    act(() => { owner.resume(); }); await settle();
    expect(screen).toHavePathname('/sample/boards/recovered');
  });

  it('ignores a covered scene callback even while its product scope remains current', async () => {
    renderRouter(routes, { initialUrl: '/sample' }); await settle();
    const covered = captured;
    act(() => captured.push('/boards/current')); await settle();
    act(() => covered.back()); await settle();
    expect(screen).toHavePathname('/sample/boards/current');
    act(() => covered.replace('/boards/old')); await settle();
    expect(screen).toHavePathname('/sample/boards/current');
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['push', 'navigate', 'replace', 'dismissTo', 'back'] as const)(
    'never revives a captured %s after same-scope cover and return', async method => {
      renderRouter(routes, { initialUrl: '/sample' }); await settle();
      const originalScope = owner.getScope();
      const stale = captured;
      act(() => captured.push('/boards/cover')); await settle();
      act(() => captured.back()); await settle();
      expect(owner.getScope()).toBe(originalScope);
      expect(screen).toHavePathname('/sample');
      act(() => { if (method === 'back') stale.back(); else stale[method]('/boards/old'); });
      await settle();
      expect(screen).toHavePathname('/sample');
      expect(close).not.toHaveBeenCalled();
      act(() => captured.push('/boards/fresh')); await settle();
      expect(screen).toHavePathname('/sample/boards/fresh');
    },
  );

});
