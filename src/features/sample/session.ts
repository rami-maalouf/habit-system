import type { DomainResult } from '@/core/domain/result';
import type { ProductCore } from '@/platform/database/product-core';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';

export type SampleSnapshot =
  | { status: 'idle' | 'opening' | 'closing' }
  | { status: 'ready'; owner: OperationOwner }
  | { status: 'error'; message: string; canRetry: boolean };

export type RealHostHandle = { suspend(): Promise<void>; resume(): void };
export type SamplePresentation = { retireScenes(): Promise<void>; leave(): void };

export class SampleSession {
  private snapshot: SampleSnapshot = { status: 'idle' };
  private listeners = new Set<() => void>();
  private host: RealHostHandle | null = null;
  private presentation: SamplePresentation | null = null;
  private hostRegistration = 0;
  private presentationRegistration = 0;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private core: ProductCore | null = null;
  private owner: OperationOwner | null = null;
  private shouldLeave = true;

  constructor(private readonly open: () => Promise<DomainResult<ProductCore>>) {}

  getSnapshot = (): SampleSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  registerRealHost(host: RealHostHandle): () => void {
    const registration = ++this.hostRegistration;
    this.host = host;
    return () => { if (this.hostRegistration === registration) this.host = null; };
  }

  registerPresentation(presentation: SamplePresentation): () => void {
    const registration = ++this.presentationRegistration;
    this.presentation = presentation;
    return () => {
      if (this.presentationRegistration !== registration) return;
      this.presentationRegistration++;
      this.presentation = null;
      void this.close(false).catch(() => {});
    };
  }

  enter(): Promise<void> {
    if (this.closing && this.snapshot.status !== 'idle') return this.opening ?? this.closing;
    if (this.snapshot.status === 'error' && this.snapshot.canRetry && !this.closing) this.opening = null;
    if (this.opening) return this.opening;
    this.closing = null;
    this.shouldLeave = true;
    this.publish({ status: 'opening' });
    let joined: Promise<void>;
    try {
      joined = this.host?.suspend() ?? Promise.resolve();
    } catch (cause) {
      this.publish({ status: 'error', message: messageOf(cause), canRetry: true });
      return Promise.resolve();
    }
    this.opening = joined.then(async () => {
      const result = await this.open();
      if (!result.ok) {
        if (!this.closing) this.publish({ status: 'error', message: result.error.message, canRetry: true });
        return;
      }
      this.core = result.value;
      this.owner = createOperationOwner(result.value, { kind: 'sample-disabled' });
      if (this.closing) await this.owner.suspend();
      else this.publish({ status: 'ready', owner: this.owner });
    }).catch(cause => {
      if (!this.closing) this.publish({ status: 'error', message: messageOf(cause), canRetry: true });
    });
    return this.opening;
  }

  close(navigate = true): Promise<void> {
    if (!navigate) this.shouldLeave = false;
    if (this.closing) return this.closing;
    const joined = this.owner?.suspend() ?? Promise.resolve();
    this.publish({ status: 'closing' });
    this.closing = (async () => {
      const retired = Promise.resolve().then(() => this.presentation?.retireScenes());
      // one rejected participant cannot leave other accepted work unjoined.
      const results = await Promise.allSettled([retired, this.opening, joined]);
      await this.core?.db.closeAsync();
      this.core = null;
      this.owner = null;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (this.shouldLeave) this.presentation?.leave();
      this.opening = null;
      this.publish({ status: 'idle' });
      this.host?.resume();
    })().catch(cause => {
      this.publish({ status: 'error', message: messageOf(cause), canRetry: false });
      throw cause;
    });
    return this.closing;
  }

  private publish(snapshot: SampleSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
