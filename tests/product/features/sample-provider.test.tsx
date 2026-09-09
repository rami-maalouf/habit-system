import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import { getHomeBoardProjection } from '@/core/domain/queries';
import { ProductProvider, useProduct, useProductQuery } from '@/features/product-store';
import { createOperationOwner } from '@/features/product-store/operation-scope';

import { createTestHarness, type TestHarness } from '../helpers/test-db';
import { FakeReminderScheduler } from '../helpers/fake-scheduler';

jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('native notification module evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('native widget constructor evaluated'); });
jest.mock('@/platform/data-transfer', () => { throw new Error('native transfer module evaluated'); });
jest.mock('@/platform/alternate-icons', () => { throw new Error('native icon module evaluated'); });
jest.mock('@/platform/sync', () => { throw new Error('native cloud module evaluated'); });
jest.mock('@/platform/time-change', () => { throw new Error('native time module evaluated'); });

describe('explicit sample product provider', () => {
  let harness: TestHarness;
  beforeEach(async () => { harness = await createTestHarness(); });
  afterEach(async () => { await harness.db.closeAsync(); });

  it('imports the public store and mounts with no real effects or native constructors', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const close = jest.fn(async () => {});
    let captured: ReturnType<typeof useProduct> | undefined;
    function Probe() {
      const product = useProduct(); captured = product;
      return <Text onPress={() => { void product.closeSample?.(); }}>{product.scope.kind}</Text>;
    }
    const view = render(<ProductProvider owner={owner} closeSample={close}><Probe /></ProductProvider>);
    expect(screen.getByText('sample')).toBeOnTheScreen();
    expect(captured!.core).toBe(owner.core);
    expect(captured!.scope).toBe(owner.getScope());
    expect(captured!.missAlertScheduler).toBeNull();
    expect(captured!.sync).toEqual({ status: 'idle', busy: false, error: null });
    expect(captured!.syncNow).toThrow('unavailable in sample mode');
    expect(captured!.pauseSync).toThrow('unavailable in sample mode');
    expect(captured!.resumeSync).toThrow('unavailable in sample mode');
    fireEvent.press(screen.getByText('sample'));
    await act(async () => {});
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(await harness.db.getFirstAsync('SELECT count(*) AS count FROM boards')).toEqual({ count: 0 });
  });

  it('subscribes to the existing owner and refuses stale callbacks without closing the core on unmount', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    let captured: ReturnType<typeof useProduct> | undefined;
    function Probe() {
      captured = useProduct();
      return <Text>{`${captured.scope.active}:${captured.version}`}</Text>;
    }
    const view = render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    const initial = captured!;
    await act(async () => { await owner.suspend(); });
    expect(screen.getByText('false:0')).toBeOnTheScreen();
    act(() => { initial.invalidate(); });
    expect(screen.getByText('false:0')).toBeOnTheScreen();
    expect(initial.nextCommandId).toThrow('inactive');
    expect(await initial.scope.run(async () => 'unexpected')).toEqual({ started: false });
    act(() => { owner.resume(); });
    expect(captured!.core).toBe(initial.core);
    expect(captured!.scope).not.toBe(initial.scope);
    expect(screen.getByText('true:0')).toBeOnTheScreen();
    expect(initial.nextCommandId).toThrow('inactive');
    act(() => { captured!.invalidate(); });
    expect(screen.getByText('true:1')).toBeOnTheScreen();
    view.unmount();
    await owner.suspend();
    expect(await harness.db.getFirstAsync('SELECT count(*) AS count FROM boards')).toEqual({ count: 0 });
  });

  it('runs an ordinary public command against only the supplied core and refreshes its query', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    function Probe() {
      const product = useProduct();
      const rows = useProductQuery(getHomeBoardProjection, []);
      return <Text onPress={() => {
        void product.scope.run(async ({ core }) => {
          const result = await createBoard(core, {
            commandId: product.nextCommandId(), title: 'Only sample', symbol: 'star.fill', accentHex: '#70A7FF',
            usesTintedBackground: true, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
          });
          if (result.ok && product.scope.isCurrent()) product.invalidate();
        });
      }}>{rows.status === 'ready' ? `boards ${rows.value.length}` : rows.status}</Text>;
    }
    render(<ProductProvider owner={owner} closeSample={async () => {}}><Probe /></ProductProvider>);
    await act(async () => {});
    fireEvent.press(screen.getByText('boards 0'));
    await act(async () => {});
    expect(screen.getByText('boards 1')).toBeOnTheScreen();
    expect(await harness.db.getAllAsync('SELECT title FROM boards')).toEqual([{ title: 'Only sample' }]);
  });

  it('rejects a mistakenly supplied real owner before any sample child or native adapter can run', () => {
    const owner = createOperationOwner(harness.deps, {
      kind: 'real', reminders: new FakeReminderScheduler(),
      missAlerts: { authorization: jest.fn(), pendingRequests: jest.fn(), presentedIdentifiers: jest.fn(),
        schedule: jest.fn(), refreshPending: jest.fn(), cancel: jest.fn() },
      cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
      supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(),
      openSystemSettings: jest.fn(),
    });
    const child = jest.fn(() => <Text>must not mount</Text>);
    const Child = child;
    expect(() => render(<ProductProvider owner={owner} closeSample={async () => {}}><Child /></ProductProvider>))
      .toThrow('requires a sample operation owner');
    expect(child).not.toHaveBeenCalled();
  });
});
