import { useLocalSearchParams } from 'expo-router';

import { parseBoardId } from '@/core/domain/ids';
import { StackDetailScreen } from '@/features/stacks/stack-detail-screen';
import { RecoveryScreen } from '@/features/ui';

export default function StackDetailRoute() {
  const { rootId } = useLocalSearchParams<{ rootId: string }>();
  const parsed = parseBoardId(rootId ?? '');
  if (!parsed) return <RecoveryScreen message="This stack link is not valid." />;
  return <StackDetailScreen key={parsed} rootId={parsed} />;
}
