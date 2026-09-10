import { act, cleanup, within } from '@testing-library/react-native';
import { RNHostView } from '@expo/ui';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';

import { ok } from '@/core/domain/result';
import { AnchorPicker } from '@/features/anchors/anchor-picker';
import { BoardIconPicker } from '@/features/board-configuration/board-icon-picker';
import { ProductProvider } from '@/features/product-store';
import { SampleHost } from '@/features/sample/host';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const banner = 'Sample data. Nothing here is saved.';

describe('sample chrome inside native picker boundaries', () => {
  let h: TestHarness, closed: boolean;
  beforeEach(async () => { h = await createTestHarness(); closed = false; });
  afterEach(async () => { cleanup(); jest.restoreAllMocks(); if (!closed) await h.db.closeAsync(); });

  it.each(['symbol', 'anchor'] as const)('keeps sample Close inside the %s RNHostView and disposes the sample', async kind => {
    const session = new SampleSession(async () => ok(h.deps));
    const nativeClose = h.db.closeAsync.bind(h.db);
    const close = jest.spyOn(h.db, 'closeAsync').mockImplementation(async () => { await nativeClose(); closed = true; });
    const leave = jest.fn();
    const normalDismiss = jest.fn();
    function Scene() {
      return kind === 'symbol'
        ? <BoardIconPicker isPresented symbol="calendar" accent="#70A7FF" onSelect={jest.fn()} onDismiss={normalDismiss} />
        : <AnchorPicker boardId={null} anchor={null} onDone={jest.fn()} onDismiss={normalDismiss} />;
    }
    function Root() { return <ThemeProvider value={DefaultTheme}><SampleSessionProvider sessionOverride={session}><Stack /></SampleSessionProvider></ThemeProvider>; }
    renderRouter({ _layout: Root, index: () => <SampleHost leave={leave}><Scene /></SampleHost> }); await settle();
    const nativeHost = screen.UNSAFE_getByType(RNHostView);
    expect(within(nativeHost).getByText(banner)).toBeOnTheScreen();
    const button = within(nativeHost).getByRole('button', { name: 'Close sample' });
    let modal = button.parent;
    while (modal && !modal.props.accessibilityViewIsModal) modal = modal.parent;
    expect(modal).not.toBeNull();
    expect(within(modal!).getByTestId(kind === 'symbol' ? 'symbol-search' : 'anchor-picker-done')).toBeOnTheScreen();
    fireEvent.press(button);
    await settle();
    await act(async () => { await session.close(); }); await settle();
    expect(close).toHaveBeenCalledTimes(1); expect(leave).toHaveBeenCalledTimes(1);
    expect(normalDismiss).not.toHaveBeenCalled();
    expect(screen.UNSAFE_queryByType(RNHostView)).toBeNull();
    await expect(h.db.getAllAsync('SELECT * FROM boards')).rejects.toThrow();
  });

  it.each(['symbol', 'anchor'] as const)('does not add sample chrome to a real %s picker', async kind => {
    const session = new SampleSession(async () => ok(h.deps));
    const dismiss = jest.fn();
    function Scene() { return kind === 'symbol'
      ? <BoardIconPicker isPresented symbol="calendar" accent="#70A7FF" onSelect={jest.fn()} onDismiss={dismiss} />
      : <AnchorPicker boardId={null} anchor={null} onDone={jest.fn()} onDismiss={dismiss} />; }
    function Root() { return <ThemeProvider value={DefaultTheme}><SampleSessionProvider sessionOverride={session}>
      <ProductProvider coreOverride={h.deps}><Stack /></ProductProvider>
    </SampleSessionProvider></ThemeProvider>; }
    renderRouter({ _layout: Root, index: Scene }); await settle();
    expect(screen.queryByText(banner)).toBeNull();
    fireEvent.press(screen.getByTestId(kind === 'symbol' ? 'close-symbol-picker' : 'anchor-picker-cancel'));
    expect(dismiss).toHaveBeenCalledTimes(1); expect(session.getSnapshot().status).toBe('idle');
  });
});
