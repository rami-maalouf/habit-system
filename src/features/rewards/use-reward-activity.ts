import { useNavigation } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useProduct } from '../product-store';

// a callback from a covered or retired reward scene cannot adopt its successor.
export function useRewardActivity() {
  const { scope } = useProduct();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const active = useRef<object | null>(null);
  const owner = useMemo(() => ({
    get active(): boolean { return active.current === this && scope.isCurrent() && focused; },
  }), [scope, focused]);
  useEffect(() => {
    active.current = owner;
    return () => { if (active.current === owner) active.current = null; };
  }, [owner]);
  const isCurrent = useCallback(() => owner.active && navigation.isFocused(), [owner, navigation]);
  return { scope, owner, isCurrent };
}
