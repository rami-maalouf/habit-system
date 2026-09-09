import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import type { RewardId } from '@/core/domain/ids';
import { getRewardClaimPreview } from '@/core/domain/reward-queries';

import { coinAmountLabel } from '../coins/history-presentation';
import { useProduct } from '../product-store';
import { claimError, claimStoreFor } from './claim-store';
import { useRewardActivity } from './use-reward-activity';

export function useRewardClaim() {
  const { core, invalidate, nextCommandId } = useProduct();
  const store = useMemo(() => claimStoreFor(core), [core]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { scope, owner, isCurrent } = useRewardActivity();
  useEffect(() => () => { store.cancel(owner); }, [store, owner]);
  useEffect(() => store.registerInvalidation(invalidate), [invalidate, store]);

  const claim = useCallback(async (rewardId: RewardId) => {
    const current = owner;
    if (!isCurrent() || !store.begin(current, rewardId)) return;
    try {
      const preview = await scope.run(({ core: accepted }) => getRewardClaimPreview(accepted, rewardId));
      if (!preview.started || !isCurrent() || !store.owns(current)) return;
      const result = preview.value;
      if (!result.ok) { store.cancel(current, result.error); invalidate(); return; }
      const { reward, balance, balanceAfterClaim } = result.value;
      if (balanceAfterClaim === null) {
        store.cancel(current, { code: 'validation', message: `${reward.title} costs ${coinAmountLabel(reward.costCoins)}. Your balance is ${coinAmountLabel(balance)}.`, retryable: false });
        invalidate();
        return;
      }
      store.confirming(current);
      const confirmed = await new Promise<boolean>(resolve => {
        let decided = false;
        const decide = (value: boolean) => { if (!decided) { decided = true; resolve(value); } };
        Alert.alert(`Claim ${reward.title}?`, `Cost: ${coinAmountLabel(reward.costCoins)}.\nBalance after claim: ${coinAmountLabel(balanceAfterClaim)}.`, [
          { text: 'Cancel', style: 'cancel', onPress: () => decide(false) },
          { text: 'Claim', onPress: () => decide(true) },
        ], { cancelable: true, onDismiss: () => decide(false) });
      });
      if (!isCurrent() || !store.owns(current)) return;
      if (!confirmed) { store.cancel(current); return; }
      await scope.run(({ core: accepted }) => store.submit(accepted, current,
        { rewardId, expectedMutationStamp: reward.mutationStamp, commandId: nextCommandId() }, invalidate));
    } catch (cause) {
      if (isCurrent() && store.owns(current)) store.cancel(current, claimError(cause));
    }
  }, [owner, isCurrent, scope, invalidate, nextCommandId, store]);

  const retry = useCallback(() => {
    if (isCurrent()) void scope.run(({ core: accepted }) => store.retry(accepted, invalidate));
  }, [isCurrent, scope, invalidate, store]);
  return { ...state, blocked: state.phase !== 'idle', claim, retry };
}
