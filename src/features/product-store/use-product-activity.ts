import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { ProductScope } from './context';

export type ProductActivity = Readonly<{ active: boolean }>;
const inactive: ProductActivity = Object.freeze({ active: false });

// callbacks retain one focus owner; returning to the route never revives it.
export function useProductActivity(scope: ProductScope): ProductActivity {
  const [activity, setActivity] = useState<ProductActivity>(inactive);
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
