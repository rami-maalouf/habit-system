import { useLocalSearchParams } from 'expo-router';

import { parseRewardId } from '@/core/domain/ids';
import { RewardFormScreen } from '@/features/rewards/reward-form-screen';
import { RecoveryScreen } from '@/features/ui';

export default function RewardRoute() {
  const { rewardId } = useLocalSearchParams<{ rewardId: string }>();
  const parsed = parseRewardId(rewardId ?? '');
  return parsed ? <RewardFormScreen key={parsed} rewardId={parsed} /> : <RecoveryScreen message="This reward link is not valid." />;
}
