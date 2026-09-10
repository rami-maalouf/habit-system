import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { err, ok } from '@/core/domain/result';
import { ProductProvider } from '@/features/product-store';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';
import * as transfer from '@/testing/data-transfer.mock';
import * as coreModule from '@/testing/product-core.mock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('real-runtime export cleanup ownership', () => {
  let harness: TestHarness;
  beforeEach(async () => { harness = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await harness.db.closeAsync(); });

  it('cleans once across strict effect replay and sample pause/resume, then once for a new real mount', async () => {
    const clean = jest.spyOn(transfer, 'cleanupStaleExports');
    const session = new SampleSession(async () => err('database', 'no sample allocation in this test'));
    const body = <StrictMode><SampleSessionProvider sessionOverride={session}>
      <ProductProvider coreOverride={harness.deps}><Text>real body</Text></ProductProvider>
    </SampleSessionProvider></StrictMode>;
    const view = render(body); await act(async () => {});
    expect(clean).toHaveBeenCalledTimes(1);
    await act(async () => { await session.enter(); await session.close(); });
    expect(clean).toHaveBeenCalledTimes(1);
    view.unmount(); await act(async () => {});
    const remount = render(body); await act(async () => {});
    expect(clean).toHaveBeenCalledTimes(2);
    remount.unmount();
  });

  it('does no cleanup or real open on a cold sample entry, then cleans at the first real mount after Close', async () => {
    const clean = jest.spyOn(transfer, 'cleanupStaleExports');
    const open = jest.spyOn(coreModule, 'getProductCore').mockResolvedValue(ok(harness.deps));
    const session = new SampleSession(async () => err('database', 'sample initialization failed'));
    await session.enter();
    const view = render(<SampleSessionProvider sessionOverride={session}>
      <ProductProvider><Text>real body</Text></ProductProvider>
    </SampleSessionProvider>);
    expect(screen.getByTestId('product-suspended')).toBeOnTheScreen();
    expect(clean).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    await act(async () => { await session.close(); });
    expect(screen.getByText('real body')).toBeOnTheScreen();
    expect(clean).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('joins an accepted asynchronous cleanup before a sample baseline without scheduling another cleanup on resume', async () => {
    const gate = deferred();
    const clean = jest.spyOn(transfer, 'cleanupStaleExports').mockImplementationOnce(() => gate.promise);
    const open = jest.fn(async () => err('database', 'no sample allocation in this test'));
    const session = new SampleSession(open);
    const view = render(<SampleSessionProvider sessionOverride={session}>
      <ProductProvider coreOverride={harness.deps}><Text>real body</Text></ProductProvider>
    </SampleSessionProvider>);
    await act(async () => {});
    expect(clean).toHaveBeenCalledTimes(1);
    let entering!: Promise<void>;
    act(() => { entering = session.enter(); }); await act(async () => {});
    expect(open).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await entering; });
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => { await session.close(); });
    expect(clean).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
