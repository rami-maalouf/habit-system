import { err, ok } from '@/core/domain/result';
import { SampleSession } from '@/features/sample/session';
import { createTestHarness } from '../helpers/test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

describe('sample session ownership', () => {
  it('joins the real host before creating a sample and shares an opening request', async () => {
    const harness = await createTestHarness();
    const held = deferred();
    const open = jest.fn(async () => ok(harness.deps));
    const host = { suspend: jest.fn(() => held.promise), resume: jest.fn() };
    const session = new SampleSession(open);
    const observed: string[] = [];
    const unsubscribe = session.subscribe(() => observed.push(session.getSnapshot().status));
    const unregister = session.registerRealHost(host);
    const first = session.enter();
    expect(session.enter()).toBe(first);
    expect(session.getSnapshot().status).toBe('opening');
    expect(host.suspend).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    held.resolve();
    await first;
    const ready = session.getSnapshot();
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error('sample did not open');
    expect(ready.owner.core.clock).toBe(harness.clock);
    expect(open).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(['opening', 'ready']);
    unsubscribe();
    unregister();
    await session.close();
  });

  it('closes cold sample memory once before leaving and returns to idle', async () => {
    const harness = await createTestHarness();
    const events: string[] = [];
    const close = jest.spyOn(harness.db, 'closeAsync').mockImplementation(async () => { events.push('close'); });
    const session = new SampleSession(async () => ok(harness.deps));
    session.registerPresentation({
      retireScenes: async () => { events.push('retire'); },
      leave: () => { events.push('leave'); },
    });
    await session.enter();
    const first = session.close();
    expect(session.close()).toBe(first);
    await first;
    expect(events).toEqual(['retire', 'close', 'leave']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().status).toBe('idle');
    close.mockRestore();
    await harness.db.closeAsync();
  });

  it('never publishes a late opened core after close has retired the session', async () => {
    const harness = await createTestHarness();
    const held = deferred();
    const close = jest.spyOn(harness.db, 'closeAsync');
    const session = new SampleSession(async () => { await held.promise; return ok(harness.deps); });
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.getSnapshot().status));
    const opening = session.enter();
    const closing = session.close();
    expect(session.getSnapshot().status).toBe('closing');
    held.resolve();
    await Promise.all([opening, closing]);
    expect(statuses).toEqual(['opening', 'closing', 'idle']);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(harness.db.getAllAsync('SELECT * FROM boards')).rejects.toThrow();
  });

  it('reopens a fresh owner and disposes its memory independently', async () => {
    const first = await createTestHarness();
    const second = await createTestHarness();
    const firstClose = jest.spyOn(first.db, 'closeAsync');
    const secondClose = jest.spyOn(second.db, 'closeAsync');
    const open = jest.fn().mockResolvedValueOnce(ok(first.deps)).mockResolvedValueOnce(ok(second.deps));
    const session = new SampleSession(open);
    await session.enter();
    const before = session.getSnapshot();
    await session.close();
    await session.enter();
    const after = session.getSnapshot();
    expect(after.status).toBe('ready');
    if (before.status !== 'ready' || after.status !== 'ready') throw new Error('sample did not open');
    expect(after.owner).not.toBe(before.owner);
    expect(before.owner.getScope().isCurrent()).toBe(false);
    expect(after.owner.getScope().isCurrent()).toBe(true);
    await session.close();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('reports failed initialization without a real fallback and permits a fresh retry', async () => {
    const harness = await createTestHarness();
    const open = jest.fn().mockResolvedValueOnce(err('database', 'seed failed'))
      .mockRejectedValueOnce('module unavailable').mockResolvedValueOnce(ok(harness.deps));
    const host = { suspend: jest.fn(async () => {}), resume: jest.fn() };
    const session = new SampleSession(open);
    session.registerRealHost(host);
    await session.enter();
    expect(session.getSnapshot()).toEqual({ status: 'error', message: 'seed failed', canRetry: true });
    await session.enter();
    expect(session.getSnapshot()).toEqual({ status: 'error', message: 'module unavailable', canRetry: true });
    expect(host.resume).not.toHaveBeenCalled();
    await session.enter();
    expect(open).toHaveBeenCalledTimes(3);
    expect(session.getSnapshot().status).toBe('ready');
    await session.close();
    expect(host.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed native disposal retired and refuses replacement or real resumption', async () => {
    const harness = await createTestHarness();
    const failure = new Error('native close failed');
    const close = jest.spyOn(harness.db, 'closeAsync').mockRejectedValue(failure);
    const open = jest.fn(async () => ok(harness.deps));
    const session = new SampleSession(open);
    const host = { suspend: jest.fn(async () => {}), resume: jest.fn() };
    const leave = jest.fn();
    session.registerRealHost(host);
    session.registerPresentation({ retireScenes: async () => {}, leave });
    await session.enter();
    const closing = session.close();
    await expect(closing).rejects.toBe(failure);
    expect(session.close()).toBe(closing);
    expect(session.getSnapshot()).toEqual({ status: 'error', message: 'native close failed', canRetry: false });
    await session.enter();
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(host.resume).not.toHaveBeenCalled();
    close.mockRestore();
    await harness.db.closeAsync();
  });

  it('retires on external route removal and never navigates a departed presentation', async () => {
    const harness = await createTestHarness();
    const held = deferred();
    const close = jest.spyOn(harness.db, 'closeAsync');
    const leave = jest.fn();
    const session = new SampleSession(async () => { await held.promise; return ok(harness.deps); });
    const remove = session.registerPresentation({ retireScenes: async () => {}, leave });
    void session.enter();
    remove();
    expect(session.getSnapshot().status).toBe('closing');
    held.resolve();
    await session.close(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('idle');
  });

  it('joins a whole accepted operation and scene retirement before closing or resuming', async () => {
    const harness = await createTestHarness();
    const held = deferred();
    const scenes = deferred();
    const events: string[] = [];
    const nativeClose = harness.db.closeAsync.bind(harness.db);
    const close = jest.spyOn(harness.db, 'closeAsync').mockImplementation(async () => {
      expect(await harness.db.getFirstAsync('SELECT icloud_sync_enabled FROM app_settings'))
        .toEqual({ icloud_sync_enabled: 1 });
      events.push('closed');
      await nativeClose();
    });
    const session = new SampleSession(async () => ok(harness.deps));
    session.registerRealHost({ suspend: async () => {}, resume: () => { events.push('resumed'); } });
    session.registerPresentation({ retireScenes: () => scenes.promise, leave: () => { events.push('left'); } });
    await session.enter();
    const ready = session.getSnapshot();
    if (ready.status !== 'ready') throw new Error('sample did not open');
    const scope = ready.owner.getScope();
    const accepted = scope.run(async ({ core }) => {
      await held.promise;
      await core.db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      events.push('accepted write');
      return 42;
    });
    const closing = session.close();
    const newWork = jest.fn(async () => {});
    expect(await scope.run(newWork)).toEqual({ started: false });
    expect(newWork).not.toHaveBeenCalled();
    held.resolve();
    expect(await accepted).toEqual({ started: true, value: 42 });
    expect(close).not.toHaveBeenCalled();
    scenes.resolve();
    await closing;
    expect(events).toEqual(['accepted write', 'closed', 'left', 'resumed']);
  });

  it('still drains accepted work and disposes memory when scene retirement fails', async () => {
    const harness = await createTestHarness();
    const held = deferred();
    const failure = new Error('scene retirement failed');
    const close = jest.spyOn(harness.db, 'closeAsync');
    const session = new SampleSession(async () => ok(harness.deps));
    const resume = jest.fn();
    const leave = jest.fn();
    session.registerRealHost({ suspend: async () => {}, resume });
    session.registerPresentation({ retireScenes: async () => { throw failure; }, leave });
    await session.enter();
    const ready = session.getSnapshot();
    if (ready.status !== 'ready') throw new Error('sample did not open');
    const accepted = ready.owner.getScope().run(async () => { await held.promise; });
    const closing = session.close().then(() => null, cause => cause);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    held.resolve();
    await accepted;
    expect(await closing).toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('a later session leaves normally after an earlier external removal', async () => {
    const first = await createTestHarness();
    const second = await createTestHarness();
    const open = jest.fn().mockResolvedValueOnce(ok(first.deps)).mockResolvedValueOnce(ok(second.deps));
    const session = new SampleSession(open);
    const remove = session.registerPresentation({ retireScenes: async () => {}, leave: jest.fn() });
    await session.enter();
    remove();
    await session.close(false);
    const leave = jest.fn();
    session.registerPresentation({ retireScenes: async () => {}, leave });
    await session.enter();
    await session.close();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('does not start memory while a route removed before entry is still retiring', async () => {
    const retired = deferred();
    const open = jest.fn(async () => err('database', 'must not open'));
    const session = new SampleSession(open);
    session.registerPresentation({ retireScenes: () => retired.promise, leave: jest.fn() });
    const closing = session.close();
    const entering = session.enter();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    retired.resolve();
    await Promise.all([closing, entering]);
    expect(session.getSnapshot().status).toBe('idle');
  });

  it('reports a synchronous host suspension failure without opening sample memory', async () => {
    const failure = new Error('listener could not retire');
    const open = jest.fn(async () => err('database', 'must not open'));
    const session = new SampleSession(open);
    session.registerRealHost({ suspend: () => { throw failure; }, resume: jest.fn() });
    await session.enter();
    expect(session.getSnapshot()).toEqual({ status: 'error', message: failure.message, canRetry: true });
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])('ignores stale presentation cleanup when the handle is reused: %s', async reuse => {
    const harness = await createTestHarness();
    const session = new SampleSession(async () => ok(harness.deps));
    const first = { retireScenes: jest.fn(async () => {}), leave: jest.fn() };
    const current = reuse ? first : { retireScenes: jest.fn(async () => {}), leave: jest.fn() };
    const oldCleanup = session.registerPresentation(first);
    session.registerPresentation(current);
    try {
      await session.enter();
      oldCleanup();
      expect(session.getSnapshot().status).toBe('ready');
      expect(await harness.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
      expect(current.retireScenes).not.toHaveBeenCalled();
    } finally { await session.close(); }
    expect(current.retireScenes).toHaveBeenCalledTimes(1);
    expect(current.leave).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('ignores stale host cleanup when the handle is reused: %s', async reuse => {
    const harness = await createTestHarness();
    const session = new SampleSession(async () => ok(harness.deps));
    const first = { suspend: jest.fn(async () => {}), resume: jest.fn() };
    const current = reuse ? first : { suspend: jest.fn(async () => {}), resume: jest.fn() };
    const oldCleanup = session.registerRealHost(first);
    session.registerRealHost(current);
    oldCleanup();
    try {
      await session.enter();
      expect(current.suspend).toHaveBeenCalledTimes(1);
    } finally { await session.close(); }
    expect(current.resume).toHaveBeenCalledTimes(1);
  });
});
