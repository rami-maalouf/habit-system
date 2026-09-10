import { act, cleanup, within } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Text } from 'react-native';

import { err } from '@/core/domain/result';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import { SettingsScreen } from '@/features/settings/settings-screen';
import { SettingsGroup } from '@/features/settings/rows';
import * as links from '@/features/settings/release-links';
import { ProductPressable } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'cancel' })) }));
jest.mock('expo-application', () => ({ nativeApplicationVersion: 'actual-version', nativeBuildVersion: '42' }));

function retainedPress(id: string): () => void {
  return screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === id)!.props.onPress;
}
function gate() {
  let reject!: (cause: Error) => void;
  const promise = new Promise<never>((_, no) => { reject = no; });
  return { promise, reject };
}

describe('Settings entry and external action authority', () => {
  let h: TestHarness, owner: OperationOwner | undefined;
  beforeEach(async () => { jest.useFakeTimers(); h = await createTestHarness(); owner = undefined; });
  afterEach(async () => { cleanup(); if (owner) await owner.suspend(); jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers(); await h.db.closeAsync(); });

  async function mount(sample = false) {
    const open = jest.fn(async () => err('database', 'fixture stops before allocation'));
    const session = new SampleSession(open);
    if (sample) owner = createOperationOwner(h.deps, { kind: 'sample-disabled' });
    function Root() {
      return <ThemeProvider value={DefaultTheme}><SampleSessionProvider sessionOverride={session}>
        {sample ? <Stack /> : <ProductProvider coreOverride={h.deps}><Stack /></ProductProvider>}
      </SampleSessionProvider></ThemeProvider>;
    }
    function Sample() { return <ProductProvider owner={owner!} closeSample={async () => {}}><Stack /></ProductProvider>; }
    renderRouter({ _layout: Root, index: SettingsScreen, other: () => <Text>Covered settings</Text>,
      'sample/_layout': sample ? Sample : () => <Stack />,
      'sample/index': sample ? SettingsScreen : () => <Text>Sample entry reached</Text>,
      'sample/settings/anchors': () => <Text>Sample anchors</Text>,
      'settings/anchors': () => <Text>Real anchors</Text>,
    }, { initialUrl: sample ? '/sample' : '/' });
    await settle();
    return { session, open };
  }

  it('offers a real-only sample entry and preserves actual readonly app metadata', async () => {
    await mount();
    expect(screen.getByTestId('settings-version')).toHaveAccessibilityValue({ text: 'actual-version (42)' });
    const utilities = screen.UNSAFE_getAllByType(SettingsGroup).find(group => group.props.title === 'Utilities')!;
    expect(within(utilities).getByTestId('settings-sample')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('settings-sample')); await settle();
    expect(screen).toHavePathname('/sample');
    expect(screen.getByText('Sample entry reached')).toBeOnTheScreen();
  });

  it('keeps sample links scoped and explains external unavailability without native effects', async () => {
    jest.spyOn(links, 'releaseLink').mockReturnValue('https://example.com/feedback');
    const external = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await mount(true);
    expect(screen.queryByTestId('settings-sample')).toBeNull();
    for (const id of ['settings-feedback', 'settings-rate', 'settings-more-products', 'settings-privacy', 'settings-terms']) {
      fireEvent.press(screen.getByTestId(id)); await settle();
      expect(screen.getByTestId('settings-link-notice')).toHaveTextContent('External links are unavailable in sample mode.');
    }
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('settings-anchors')); await settle();
    expect(screen).toHavePathname('/sample/settings/anchors');
  });

  it.each(['scope', 'focus', 'unmount'] as const)('retires captured links and entry after %s retirement', async retirement => {
    jest.spyOn(links, 'releaseLink').mockReturnValue('https://example.com/feedback');
    const { session } = await mount();
    const oldLink = retainedPress('settings-feedback');
    const oldEntry = retainedPress('settings-sample');
    if (retirement === 'scope') { await act(async () => { await session.enter(); await session.close(); }); await settle(); }
    else {
      act(() => retirement === 'focus' ? router.push('/other' as Href) : router.replace('/other' as Href)); await settle();
      if (retirement === 'focus') { act(() => router.back()); await settle(); }
    }
    act(() => { oldLink(); oldEntry(); }); await settle();
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    expect(screen).toHavePathname(retirement === 'unmount' ? '/other' : '/');
    if (retirement !== 'unmount') {
      fireEvent.press(screen.getByTestId('settings-feedback')); await settle();
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['browser', 'store'] as const)('joins a started %s and never publishes a retired failure or duplicates a queued callback', async target => {
    jest.spyOn(links, 'releaseLink').mockReturnValue('https://example.com/destination');
    const held = gate();
    const browser = jest.spyOn(WebBrowser, 'openBrowserAsync');
    const external = jest.spyOn(Linking, 'openURL');
    if (target === 'browser') browser.mockReturnValueOnce(held.promise);
    else external.mockReturnValueOnce(held.promise);
    const { session, open } = await mount();
    const originalSettings = await h.db.getAllAsync('SELECT * FROM app_settings');
    const callback = retainedPress(target === 'browser' ? 'settings-feedback' : 'settings-rate');
    act(() => { callback(); callback(); }); await settle();
    expect(target === 'browser' ? browser : external).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await settle();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { held.reject(new Error('private native failure')); await entering; await session.close(); }); await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-link-notice')).toBeNull();
    expect(await h.db.getAllAsync('SELECT * FROM app_settings')).toEqual(originalSettings);
  });

  it('shows a sanitized active failure then allows a new attempt', async () => {
    jest.spyOn(links, 'releaseLink').mockReturnValue('https://example.com/feedback');
    jest.spyOn(WebBrowser, 'openBrowserAsync').mockRejectedValueOnce(new Error('private native failure'));
    await mount();
    fireEvent.press(screen.getByTestId('settings-feedback')); await settle();
    expect(screen.getByTestId('settings-link-notice')).toHaveTextContent('Request feature or report issue could not be opened. Try again.');
    fireEvent.press(screen.getByTestId('settings-feedback')); await settle();
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('settings-link-notice')).toBeNull();
  });
});
