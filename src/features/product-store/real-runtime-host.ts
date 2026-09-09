import type { OperationOwner } from './operation-scope';

// one provider owns startup and real effects before and after its core opens.
export class RealRuntimeHost {
  private active = true;
  private revision = 0;
  private owner: OperationOwner | null = null;
  private pending = new Set<Promise<unknown>>();
  private stops = new Set<() => void>();
  private listeners = new Set<() => void>();
  private joining: Promise<void> | null = null;
  private cleanupFailures: unknown[] = [];

  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isCurrent = (revision: number) => this.active && this.revision === revision;

  attach(owner: OperationOwner) {
    this.owner = owner;
    if (!this.active) void owner.suspend();
  }

  track<Value>(work: () => Promise<Value>): Promise<Value> {
    let resolve!: (value: Value | PromiseLike<Value>) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    try { resolve(work()); } catch (cause) { reject(cause); }
    return promise;
  }

  retain(stop: () => void | Promise<void>): () => void {
    const cleanup = () => {
      if (!this.stops.delete(cleanup)) return;
      void this.track(async () => {
        try { await stop(); }
        catch (cause) { this.cleanupFailures.push(cause); throw cause; }
      }).catch(() => {});
    };
    this.stops.add(cleanup);
    return cleanup;
  }

  suspend = (): Promise<void> => {
    if (this.joining) return this.joining;
    this.active = false;
    this.revision++;
    const operations = this.owner?.suspend();
    for (const stop of this.stops) stop();
    this.joining = Promise.allSettled([operations, ...this.pending]).then(() => {
      if (this.cleanupFailures.length) throw this.cleanupFailures[0];
    });
    this.publish();
    return this.joining;
  };

  resume = () => {
    if (this.active) return;
    // retrying removed ownership bookkeeping cannot prove native cleanup.
    if (this.cleanupFailures.length) throw this.cleanupFailures[0];
    this.owner?.resume();
    this.joining = null;
    this.active = true;
    this.revision++;
    this.publish();
  };

  private publish() { for (const listener of this.listeners) listener(); }
}
