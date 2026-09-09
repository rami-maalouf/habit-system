import { act, cleanup, fireEvent, render as renderNative, screen } from '@testing-library/react-native';
import { StrictMode, useEffect, type ReactElement } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createBoard } from '@/core/domain/commands';
import { err, ok } from '@/core/domain/result';
import { useProduct } from '@/features/product-store';
import { SampleHost } from '@/features/sample/host';
import { SampleChrome } from '@/features/sample/chrome';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('real notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('real widgets evaluated'); });

const banner = 'Sample data. Nothing here is saved.';
function render(ui: ReactElement) {
  return renderNative(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 59, bottom: 34, left: 0, right: 0 } }}>{ui}</SafeAreaProvider>);
}

describe('sample presentation ownership', () => {
  let harness: TestHarness;
  let closed: boolean;
  beforeEach(async () => { harness = await createTestHarness(); closed = false; });
  afterEach(async () => { cleanup(); jest.restoreAllMocks(); if (!closed) await harness.db.closeAsync(); });

  it('unmounts scene effects and joins an accepted public command before disposal and leaving', async () => {
    const order: string[] = [];
    let product: ReturnType<typeof useProduct> | undefined;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const session = new SampleSession(async () => ok(harness.deps));
    const closeNative = harness.db.closeAsync.bind(harness.db);
    const close = jest.spyOn(harness.db, 'closeAsync').mockImplementation(async () => {
      expect(await harness.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Accepted sample' }]);
      order.push('close');
      await closeNative();
      closed = true;
    });
    const leave = jest.fn(() => { order.push('leave'); });
    session.registerRealHost({ suspend: async () => {}, resume: () => { order.push('resume'); } });
    function Scene() {
      product = useProduct();
      useEffect(() => () => { order.push('scene cleanup'); }, []);
      return <Text>Sample scene</Text>;
    }
    render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={leave}><Scene /></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    expect(screen.getByText(banner)).toBeOnTheScreen();
    expect(screen.getByText('Sample scene')).toBeOnTheScreen();
    const accepted = product!.scope.run(async ({ core }) => {
      await held;
      const result = await createBoard(core, {
        commandId: harness.ids.nextCommandId(), title: 'Accepted sample', symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: true, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      });
      order.push('command');
      return result;
    });
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    expect(product!.scope.isCurrent()).toBe(false);
    await act(async () => {});
    expect(screen.queryByText('Sample scene')).toBeNull();
    expect(screen.getByText(banner)).toBeOnTheScreen();
    expect(screen.getByText('Closing sample...')).toBeOnTheScreen();
    expect(close).not.toHaveBeenCalled();
    await act(async () => { release(); await accepted; await session.close(); });
    expect(order).toEqual(['scene cleanup', 'command', 'close', 'leave', 'resume']);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(harness.db.getAllAsync('SELECT * FROM boards')).rejects.toThrow();
  });

  it('keeps Close visible while opening and never mounts a late sample after it was closed', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const session = new SampleSession(async () => { await held; return ok(harness.deps); });
    const leave = jest.fn();
    const close = jest.spyOn(harness.db, 'closeAsync').mockResolvedValue();
    const mounted = jest.fn();
    function Scene() { mounted(); return <Text>Late scene</Text>; }
    render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={leave}><Scene /></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    expect(screen.getByText(banner)).toBeOnTheScreen();
    expect(screen.getByText('Preparing three years of sample data...')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    await act(async () => {});
    expect(leave).not.toHaveBeenCalled();
    await act(async () => { release(); await session.close(); });
    expect(mounted).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('shows initialization failure and retries explicitly without a real fallback', async () => {
    const open = jest.fn().mockResolvedValueOnce(err('database', 'Sample could not open')).mockResolvedValueOnce(ok(harness.deps));
    const session = new SampleSession(open);
    const close = jest.spyOn(harness.db, 'closeAsync').mockResolvedValue();
    render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={() => {}}><Text>Retried scene</Text></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    expect(screen.getByText('Sample could not open')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Close sample' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(screen.getByText('Retried scene')).toBeOnTheScreen();
    expect(open).toHaveBeenCalledTimes(2);
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    await act(async () => {});
    await session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('acknowledges external removal and keeps a failed disposal visible without resumption or retry', async () => {
    const session = new SampleSession(async () => ok(harness.deps));
    const resume = jest.fn();
    const leave = jest.fn();
    session.registerRealHost({ suspend: async () => {}, resume });
    const close = jest.spyOn(harness.db, 'closeAsync').mockRejectedValue(new Error('Memory close failed'));
    const view = render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={leave}><Text>Sample scene</Text></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    await act(async () => {});
    expect(screen.getByText('Memory close failed')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Sample scene')).toBeNull();
    expect(leave).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {});
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not navigate on real external removal, including while retirement is pending', async () => {
    const session = new SampleSession(async () => ok(harness.deps));
    const close = jest.spyOn(harness.db, 'closeAsync').mockResolvedValue();
    const leave = jest.fn();
    const view = render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={leave}><Text>Sample scene</Text></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    act(() => { void session.close(); view.unmount(); });
    await act(async () => { await session.close(); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('idle');
  });

  it('opens once and stays usable through actual strict-mode mount replay', async () => {
    const open = jest.fn(async () => ok(harness.deps));
    const session = new SampleSession(open);
    const close = jest.spyOn(harness.db, 'closeAsync').mockResolvedValue();
    let setups = 0;
    function Probe() { useEffect(() => { setups++; }, []); return <Text>Mounted sample</Text>; }
    const view = render(<StrictMode><SampleSessionProvider sessionOverride={session}><SampleHost leave={() => {}}><Probe /></SampleHost></SampleSessionProvider></StrictMode>);
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Mounted sample')).toBeOnTheScreen();
    expect(setups).toBe(2);
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => { await session.close(); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not show sample chrome in a real scene merely because the root has a sample session', () => {
    render(<SampleSessionProvider><SampleChrome /></SampleSessionProvider>);
    expect(screen.queryByText(banner)).toBeNull();
  });

  it('honors Close before deferred entry without opening memory or cancelling the requested leave', async () => {
    const open = jest.fn(async () => ok(harness.deps));
    const session = new SampleSession(open);
    const leave = jest.fn();
    render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={leave}><Text>Should not mount</Text></SampleHost></SampleSessionProvider>);
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Should not mount')).toBeNull();
  });

  it('retains the original route leave across renders without retiring the current presentation', async () => {
    const open = jest.fn(async () => ok(harness.deps));
    const session = new SampleSession(open);
    const first = jest.fn();
    const replacement = jest.fn();
    const close = jest.spyOn(harness.db, 'closeAsync').mockResolvedValue();
    const view = render(<SampleSessionProvider sessionOverride={session}><SampleHost leave={first}><Text>Sample scene</Text></SampleHost></SampleSessionProvider>);
    await act(async () => {});
    view.rerender(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 59, bottom: 34, left: 0, right: 0 } }}><SampleSessionProvider sessionOverride={session}>
      <SampleHost leave={replacement}><Text>Updated scene</Text></SampleHost>
    </SampleSessionProvider></SafeAreaProvider>);
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText('Updated scene')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Close sample' }));
    await act(async () => {});
    expect(first).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
});
