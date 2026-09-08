import { Alert } from 'react-native';

import type { DailyToggleSnapshot } from '@/core/domain/queries';

export function confirmDailyUncheck(snapshot: DailyToggleSnapshot): Promise<boolean> {
  return new Promise((resolve) => {
    const checks = `${snapshot.checkInCount} ${snapshot.checkInCount === 1 ? 'check-in' : 'check-ins'}`;
    const notes = `${snapshot.noteCount} ${snapshot.noteCount === 1 ? 'note' : 'notes'}`;
    Alert.alert(
      `Uncheck ${snapshot.boardTitle}?`,
      `For ${snapshot.logicalDate}, this removes ${checks} and ${notes}.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Uncheck', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
