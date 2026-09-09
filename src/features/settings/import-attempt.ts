import { importSnapshot, type ImportSnapshotInput, type ImportSummary } from '@/core/domain/commands';
import type { CommandId } from '@/core/domain/ids';
import type { DomainError } from '@/core/domain/result';
import { captureImportDraft } from '@/core/export/import-capture';
import { getImportPreview, type ImportDraft, type ImportPreview } from '@/core/export/import-parsers';
import type { ProductCore } from '@/platform/database/product-core';

export type ImportOwner = { active: boolean };
type Details = ImportPreview & { fileName: string; source: ImportDraft['source']; exportVersion?: 1 | 2 };
type Attempt = { input: ImportSnapshotInput; details: Details };
type ImportAttemptView =
  | { phase: 'idle' }
  | (Details & { phase: 'running' | 'uncertain' | 'failed'; commandId: CommandId; error: DomainError | null })
  | { phase: 'done'; fileName: string; commandId: CommandId; summary: ImportSummary };

function captureSummary(summary: ImportSummary): ImportSummary {
  return Object.freeze({ ...summary, ...(summary.v2 ? { v2: Object.freeze({ ...summary.v2,
    immutable: Object.freeze({ ...summary.v2.immutable }),
  }) } : {}) });
}

// submitted work belongs to the provider's core and survives import route remounts.
class ImportAttemptStore {
  private state: ImportAttemptView = { phase: 'idle' };
  private attempt: Attempt | null = null;
  private listeners = new Set<() => void>();
  private invalidators = new Set<{ callback: () => void }>();

  constructor(private core: ProductCore) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  registerInvalidation(callback: () => void) {
    const entry = { callback }; this.invalidators.add(entry);
    return () => { this.invalidators.delete(entry); };
  }
  private publish(state: ImportAttemptView) {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
  async start(owner: ImportOwner, fileName: string, draft: ImportDraft, nextCommandId: () => CommandId, invalidate: () => void,
    executionCore: ProductCore = this.core) {
    if (!owner.active || this.state.phase !== 'idle') return;
    const captured = captureImportDraft(draft);
    if (!captured.ok) throw new Error(captured.error.message);
    const preview = getImportPreview(captured.value);
    if (!preview.ok) throw new Error(preview.error.message);
    const attempt = { input: Object.freeze({ commandId: nextCommandId(), draft: captured.value }),
      details: { ...preview.value, fileName, source: captured.value.source, exportVersion: captured.value.exportVersion } };
    this.attempt = attempt;
    await this.run(attempt, invalidate, executionCore);
  }
  async retry(owner: ImportOwner, commandId: CommandId, invalidate: () => void, executionCore: ProductCore = this.core) {
    if (!owner.active || this.state.phase !== 'uncertain' || this.state.commandId !== commandId || this.attempt === null) return;
    await this.run(this.attempt, invalidate, executionCore);
  }
  startAnother(owner: ImportOwner, commandId: CommandId) {
    if (!owner.active || (this.state.phase !== 'done' && this.state.phase !== 'failed') || this.state.commandId !== commandId) return false;
    this.attempt = null;
    this.publish({ phase: 'idle' });
    return true;
  }
  private async run(attempt: Attempt, invalidate: () => void, executionCore: ProductCore) {
    const view = { ...attempt.details, commandId: attempt.input.commandId };
    // this immediate transition blocks queued callbacks before react renders.
    this.publish({ ...view, phase: 'running', error: null });
    try {
      const result = await importSnapshot(executionCore, attempt.input);
      if (this.attempt !== attempt) return;
      if (result.ok) {
        this.attempt = null;
        this.publish({ phase: 'done', fileName: view.fileName, commandId: view.commandId,
          summary: captureSummary(result.value) });
      } else {
        if (!result.error.retryable) this.attempt = null;
        this.publish({ ...view, phase: result.error.retryable ? 'uncertain' : 'failed', error: result.error });
      }
    } catch {
      if (this.attempt === attempt) this.publish({ ...view, phase: 'uncertain',
        error: { code: 'database', message: 'The import response was interrupted. Try again.', retryable: true } });
    } finally {
      // an interrupted response may follow a real commit, including after navigation.
      const callbacks = new Set([...this.invalidators].map(entry => entry.callback));
      if (callbacks.size === 0) callbacks.add(invalidate);
      for (const callback of callbacks) callback();
    }
  }
}

const stores = new WeakMap<ProductCore, ImportAttemptStore>();
export function importAttemptStoreFor(core: ProductCore) {
  let store = stores.get(core);
  if (!store) { store = new ImportAttemptStore(core); stores.set(core, store); }
  return store;
}
