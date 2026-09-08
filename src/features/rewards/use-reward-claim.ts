import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { Alert } from 'react-native';

import type { RewardId } from '@/core/domain/ids';
import { getRewardClaimPreview } from '@/core/domain/reward-queries';

import { coinAmountLabel } from '../coins/history-presentation';
import { useProduct } from '../product-store';
import { claimError, claimStoreFor, type ClaimOwner } from './claim-store';

export function useRewardClaim() {
  const { core, invalidate, nextCommandId } = useProduct();
  const store = useMemo(() => claimStoreFor(core), [core]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const owner = useRef<ClaimOwner | null>(null);
  useFocusEffect(useCallback(() => {
    const current = { active: true };
    owner.current = current;
    return () => { current.active = false; store.cancel(current); };
  }, [store]));
  useEffect(() => store.registerInvalidation(invalidate), [invalidate, store]);

  const claim = useCallback(async (rewardId: RewardId) => {
    const current = owner.current;
    if (!current || !store.begin(current, rewardId)) return;
    try {
      const result = await getRewardClaimPreview(core, rewardId);
      if (!store.owns(current)) return;
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
      if (!store.owns(current)) return;
      if (!confirmed) { store.cancel(current); return; }
      await store.submit(core, current, { rewardId, expectedMutationStamp: reward.mutationStamp, commandId: nextCommandId() }, invalidate);
    } catch (cause) {
      if (store.owns(current)) store.cancel(current, claimError(cause));
    }
  }, [core, invalidate, nextCommandId, store]);

  const retry = useCallback(() => { void store.retry(core, invalidate); }, [core, invalidate, store]);
  return { ...state, blocked: state.phase !== 'idle', claim, retry };
}
