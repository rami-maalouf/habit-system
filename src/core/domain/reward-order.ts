import type { Reward } from './entities';
import type { RewardId } from './ids';
import { orderKeyBetween } from './order-key';

// the caller supplies the final order with one inserted or moved reward.
export function rewardOrderKeys(
  ordered: readonly Pick<Reward, 'id' | 'orderKey'>[], index: number,
): ReadonlyMap<RewardId, string> {
  const previous = ordered[index - 1]?.orderKey ?? null;
  const next = ordered[index + 1]?.orderKey ?? null;
  try {
    const key = orderKeyBetween(previous, next);
    if ((previous === null || key > previous) && (next === null || key < next)) {
      return new Map([[ordered[index].id, key]]);
    }
  } catch {
    // tied keys or exhausted fractional depth require one deterministic rebalance.
  }
  const width = (ordered.length * 2).toString(36).length;
  return new Map(ordered.map((reward, position) =>
    [reward.id, (position * 2 + 1).toString(36).padStart(width, '0')]));
}
