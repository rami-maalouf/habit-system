import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { ProductScope } from '../product-store/context';

type SettingsActivity = Readonly<{ active: boolean }>;
const inactive: SettingsActivity = Object.freeze({ active: false });

// callbacks retain one focus owner; a later focus never revives that owner.
export function useSettingsActivity(scope: ProductScope): SettingsActivity {
  const [activity, setActivity] = useState<SettingsActivity>(inactive);
  useFocusEffect(useCallback(() => {
    let focused = true;
    const current = Object.freeze({ get active() { return focused && scope.isCurrent(); } });
    setActivity(current);
    return () => {
      focused = false;
      setActivity(previous => previous === current ? inactive : previous);
    };
  }, [scope]));
  return activity;
}
