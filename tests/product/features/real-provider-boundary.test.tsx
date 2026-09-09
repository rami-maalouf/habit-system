import { act, render } from '@testing-library/react-native';
import { StrictMode, useEffect } from 'react';
import { Text } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import { ProductProvider, useProduct } from '@/features/product-store';
import * as notifications from '@/testing/notifications-platform.mock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

describe('real provider effect composition', () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await createTestHarness();
    notifications.notificationsPlatformMock.reset();
  });
  afterEach(async () => { jest.restoreAllMocks(); await harness.db.closeAsync(); });

  it('registers foreground presentation only for the real mount and retires its registration on unmount', async () => {
    const retire = jest.fn();
    const install = jest.spyOn(notifications, 'installNotificationHandler').mockReturnValue(retire);
    expect(install).not.toHaveBeenCalled();
    const view = render(<ProductProvider coreOverride={harness.deps}><Text>real</Text></ProductProvider>);
    await act(async () => {});
    expect(install).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('captures the initial injected feature port while later replacement updates coordinator and count only', async () => {
    const first = { ...notifications.missAlertScheduler };
    const replacement = { ...notifications.missAlertScheduler };
    let captured: ReturnType<typeof useProduct> | undefined;
    function Probe() { captured = useProduct(); return <Text>real</Text>; }
    const view = render(<ProductProvider coreOverride={harness.deps} missAlertSchedulerOverride={first}><Probe /></ProductProvider>);
    await act(async () => {});
    const original = captured!;
    expect(original.scope.kind).toBe('real');
    expect(original.closeSample).toBeNull();
    await original.scope.run(async ({ core, effects }) => {
      expect(core).toBe(harness.deps);
      expect(effects.kind === 'real' && effects.missAlerts).toBe(first);
    });
    view.rerender(<ProductProvider coreOverride={harness.deps} missAlertSchedulerOverride={replacement}><Probe /></ProductProvider>);
    await act(async () => {});
    expect(captured!.core).toBe(original.core);
    expect(captured!.scope).toBe(original.scope);
    expect(captured!.missAlertScheduler).toBe(replacement);
    await captured!.scope.run(async ({ effects }) => {
      expect(effects.kind === 'real' && effects.missAlerts).toBe(first);
    });
    view.unmount();
  });

  it('retires stale UI dispatch on unmount while an accepted public command finishes on the real singleton', async () => {
    let captured: ReturnType<typeof useProduct> | undefined;
    function Probe() { captured = useProduct(); return <Text>real</Text>; }
    const view = render(<ProductProvider coreOverride={harness.deps}><Probe /></ProductProvider>);
    await act(async () => {});
    const original = captured!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const work = original.scope.run(async ({ core }) => {
      await held;
      return createBoard(core, {
        commandId: harness.ids.nextCommandId(), title: 'Accepted before unmount', symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: true, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      });
    });
    view.unmount();
    const currentAfterUnmount = original.scope.isCurrent();
    const obsolete = jest.fn(async () => 'unexpected');
    const dispatch = await original.scope.run(obsolete);
    release();
    expect(await work).toMatchObject({ started: true, value: { ok: true } });
    expect(currentAfterUnmount).toBe(false);
    expect(dispatch).toEqual({ started: false });
    expect(obsolete).not.toHaveBeenCalled();
    expect(await harness.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Accepted before unmount' }]);
  });

  it('resumes the same core with fresh authority after actual strict-mode effect replay', async () => {
    const committed: ReturnType<typeof useProduct>[] = [];
    let setups = 0;
    let cleanups = 0;
    let latest: ReturnType<typeof useProduct> | undefined;
    function Probe() {
      const product = useProduct(); latest = product;
      useEffect(() => { setups++; return () => { cleanups++; }; }, []);
      useEffect(() => { committed.push(product); }, [product]);
      return <Text>{product.scope.active ? 'active' : 'retired'}</Text>;
    }
    const view = render(<StrictMode><ProductProvider coreOverride={harness.deps}><Probe /></ProductProvider></StrictMode>);
    await act(async () => {});
    expect(setups).toBe(2);
    expect(cleanups).toBe(1);
    expect(latest!.scope.active).toBe(true);
    expect(latest!.scope.isCurrent()).toBe(true);
    expect(latest!.scope).not.toBe(committed[0].scope);
    expect(committed[0].scope.isCurrent()).toBe(false);
    expect(committed.every(product => product.core === latest!.core)).toBe(true);
    const current = latest!;
    view.unmount();
    expect(current.scope.isCurrent()).toBe(false);
    expect(cleanups).toBe(2);
  });

  it('does not resume a replayed owner after final unmount while its accepted work is still draining', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let work: ReturnType<ReturnType<typeof useProduct>['scope']['run']> | undefined;
    let latest: ReturnType<typeof useProduct> | undefined;
    function Probe() {
      const product = useProduct(); latest = product;
      useEffect(() => {
        if (!work) work = product.scope.run(() => held);
      }, [product.scope]);
      return <Text>real</Text>;
    }
    const view = render(<StrictMode><ProductProvider coreOverride={harness.deps}><Probe /></ProductProvider></StrictMode>);
    expect(work).toBeDefined();
    view.unmount();
    await act(async () => { release(); await work; });
    await expect(latest!.core.db.getFirstAsync('SELECT count(*) AS count FROM boards')).rejects.toThrow('inactive');
    expect(await harness.db.getFirstAsync('SELECT count(*) AS count FROM boards')).toEqual({ count: 0 });
  });
});
