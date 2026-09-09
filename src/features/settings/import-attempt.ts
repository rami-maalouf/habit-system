import { importSnapshot, type ImportSnapshotInput, type ImportSummary } from '@/core/domain/commands';
import type { CommandId } from '@/core/domain/ids';
import type { DomainError } from '@/core/domain/result';
import type { ImportDraft } from '@/core/export/import-parsers';
import type { ProductCore } from '@/platform/database/product-core';

export type ImportOwner = { active: boolean };
type Details = { fileName: string; source: ImportDraft['source']; boards: number; checkIns: number };
type Attempt = { input: ImportSnapshotInput; details: Details };
type ImportAttemptView =
  | { phase: 'idle' }
  | (Details & { phase: 'running' | 'uncertain' | 'failed'; commandId: CommandId; error: DomainError | null })
  | { phase: 'done'; fileName: string; commandId: CommandId; summary: ImportSummary };

function captureDraft(draft: ImportDraft): ImportDraft {
  const captured: ImportDraft = {
    source: draft.source,
    boards: draft.boards.map(board => ({ ...board,
      periods: board.periods === null ? null : board.periods.map(period => Object.freeze({ ...period })),
    })),
    checkIns: draft.checkIns.map(check => Object.freeze({ ...check })),
    reminders: draft.reminders.map(reminder => Object.freeze({ ...reminder })),
  };
  for (const board of captured.boards) { Object.freeze(board.periods); Object.freeze(board); }
  Object.freeze(captured.boards); Object.freeze(captured.checkIns); Object.freeze(captured.reminders);
  return Object.freeze(captured);
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
  async start(owner: ImportOwner, fileName: string, draft: ImportDraft, nextCommandId: () => CommandId, invalidate: () => void) {
    if (!owner.active || this.state.phase !== 'idle') return;
    const captured = captureDraft(draft);
    const attempt = { input: Object.freeze({ commandId: nextCommandId(), draft: captured }),
      details: { fileName, source: captured.source, boards: captured.boards.length, checkIns: captured.checkIns.length } };
    this.attempt = attempt;
    await this.run(attempt, invalidate);
  }
  async retry(owner: ImportOwner, commandId: CommandId, invalidate: () => void) {
    if (!owner.active || this.state.phase !== 'uncertain' || this.state.commandId !== commandId || this.attempt === null) return;
    await this.run(this.attempt, invalidate);
  }
  startAnother(owner: ImportOwner, commandId: CommandId) {
    if (!owner.active || (this.state.phase !== 'done' && this.state.phase !== 'failed') || this.state.commandId !== commandId) return false;
    this.attempt = null;
    this.publish({ phase: 'idle' });
    return true;
  }
  private async run(attempt: Attempt, invalidate: () => void) {
    const view = { ...attempt.details, commandId: attempt.input.commandId };
    // this immediate transition blocks queued callbacks before react renders.
    this.publish({ ...view, phase: 'running', error: null });
    try {
      const result = await importSnapshot(this.core, attempt.input);
      if (this.attempt !== attempt) return;
      if (result.ok) {
        this.attempt = null;
        this.publish({ phase: 'done', fileName: view.fileName, commandId: view.commandId,
          summary: Object.freeze({ ...result.value }) });
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
