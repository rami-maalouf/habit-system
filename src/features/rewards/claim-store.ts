import { claimReward } from '@/core/domain/reward-commands';
import type { ClaimRewardInput, ClaimRewardResult } from '@/core/domain/reward-commands';
import type { DomainError } from '@/core/domain/result';
import type { RewardId } from '@/core/domain/ids';
import type { ProductCore } from '@/platform/database/product-core';

export type ClaimOwner = { active: boolean };
type ClaimState = {
  phase: 'idle' | 'preview' | 'confirmation' | 'running' | 'uncertain';
  rewardId: RewardId | null;
  attempt: ClaimRewardInput | null;
  error: DomainError | null;
  result: ClaimRewardResult | null;
};

export function claimError(cause: unknown): DomainError {
  return { code: 'database', message: cause instanceof Error ? cause.message : String(cause), retryable: true };
}

// one transient claim per database, shared by route instances and isolated from sample mode.
class ClaimStore {
  private state: ClaimState = { phase: 'idle', rewardId: null, attempt: null, error: null, result: null };
  private listeners = new Set<() => void>();
  private invalidators = new Set<{ callback: () => void }>();
  private owner: ClaimOwner | null = null;
  private operation = 0;

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  registerInvalidation(callback: () => void) {
    const entry = { callback }; this.invalidators.add(entry);
    return () => { this.invalidators.delete(entry); };
  }
  private publish(patch: Partial<ClaimState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  owns(owner: ClaimOwner) { return owner.active && this.owner === owner; }
  begin(owner: ClaimOwner, rewardId: RewardId) {
    if (!owner.active || this.state.phase !== 'idle') return false;
    this.owner = owner;
    this.publish({ phase: 'preview', rewardId, error: null, result: null });
    return true;
  }
  confirming(owner: ClaimOwner) { if (this.owns(owner)) this.publish({ phase: 'confirmation' }); }
  cancel(owner: ClaimOwner, error: DomainError | null = null) {
    if (this.owner !== owner || !['preview', 'confirmation'].includes(this.state.phase)) return;
    this.owner = null;
    this.publish({ phase: 'idle', rewardId: null, error });
  }
  async submit(core: ProductCore, owner: ClaimOwner, attempt: ClaimRewardInput, invalidate: () => void) {
    if (!this.owns(owner) || this.state.phase !== 'confirmation') return;
    await this.run(core, attempt, invalidate);
  }
  async retry(core: ProductCore, invalidate: () => void) {
    if (this.state.phase !== 'uncertain' || this.state.attempt === null) return;
    await this.run(core, this.state.attempt, invalidate);
  }
  private async run(core: ProductCore, attempt: ClaimRewardInput, invalidate: () => void) {
    const operation = ++this.operation;
    this.owner = null;
    // publish the immutable attempt before dispatch so a remounted controller cannot submit again.
    this.publish({ phase: 'running', attempt, rewardId: attempt.rewardId, error: null, result: null });
    try {
      const result = await claimReward(core, attempt);
      if (operation !== this.operation) return;
      if (result.ok) this.publish({ phase: 'idle', attempt: null, rewardId: null, result: result.value, error: null });
      else this.publish({ phase: result.error.retryable ? 'uncertain' : 'idle',
        attempt: result.error.retryable ? attempt : null, rewardId: result.error.retryable ? attempt.rewardId : null,
        error: result.error });
    } catch (cause) {
      if (operation === this.operation) this.publish({ phase: 'uncertain', error: claimError(cause) });
    } finally {
      // submitted work can settle after navigation; the rest of the app still needs fresh totals.
      const callbacks = new Set([...this.invalidators].map(entry => entry.callback));
      if (callbacks.size === 0) callbacks.add(invalidate);
      for (const callback of callbacks) callback();
    }
  }
}

const stores = new WeakMap<ProductCore, ClaimStore>();
export function claimStoreFor(core: ProductCore) {
  let store = stores.get(core);
  if (!store) { store = new ClaimStore(); stores.set(core, store); }
  return store;
}
