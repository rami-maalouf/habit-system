import { useLocalSearchParams } from 'expo-router';

import { parseBoardId } from '@/core/domain/ids';
import { DailyWidgetActionScreen } from '@/features/boards/daily-widget-action-screen';
import { RecoveryScreen } from '@/features/ui';

export default function DailyWidgetActionRoute() {
  const { boardId } = useLocalSearchParams<{ boardId: string }>();
  const parsed = parseBoardId(boardId ?? '');
  if (!parsed) return <RecoveryScreen message="This board link is not valid." />;
  return <DailyWidgetActionScreen key={parsed} boardId={parsed} />;
}
