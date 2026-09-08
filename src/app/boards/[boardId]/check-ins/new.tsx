import { useLocalSearchParams } from 'expo-router';

import { parseBoardId } from '@/core/domain/ids';
import { CheckInFormScreen } from '@/features/check-in-history';
import { WidgetCheckInEntryScreen } from '@/features/boards/daily-widget-action-screen';
import { RecoveryScreen } from '@/features/ui';

export default function AddCheckInRoute() {
  const { boardId, source } = useLocalSearchParams<{ boardId: string; source?: string }>();
  const parsed = parseBoardId(boardId ?? '');
  if (!parsed) {
    return <RecoveryScreen message="This board link is not valid." />;
  }
  return source === 'widget' ? <WidgetCheckInEntryScreen boardId={parsed} /> : <CheckInFormScreen boardId={parsed} checkInId={null} />;
}
