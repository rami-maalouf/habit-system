import { Stack, useFocusEffect, useNavigation, usePathname, useRouter } from 'expo-router';
import { usePreventRemove, useRoute, type NavigationAction } from 'expo-router/react-navigation';
import { useCallback, useRef, useState } from 'react';
import { BackHandler } from 'react-native';

import { SampleHost } from '@/features/sample/host';
import { useSampleSession } from '@/features/sample/session-context';

export default function SampleLayout() {
  const navigation = useNavigation();
  const route = useRoute();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSampleSession();
  const [origin] = useState(() => {
    const state = navigation.getState();
    return { routeKey: route.key, navigatorKey: state?.key,
      warm: (state?.routes.findIndex(entry => entry.key === route.key) ?? 0) > 0 };
  });
  const removal = useRef<NavigationAction | null>(null);
  const leaving = useRef(false);
  usePreventRemove(true, ({ data }) => {
    if (leaving.current) { navigation.dispatch(data.action); return; }
    removal.current ??= data.action;
    void session.close().catch(() => {});
  });
  const leave = useCallback(() => {
    const state = navigation.getState();
    if (!state?.routes.some(entry => entry.key === origin.routeKey)) return;
    leaving.current = true;
    if (removal.current) navigation.dispatch(removal.current);
    else if (origin.warm) navigation.dispatch({ type: 'POP', payload: { count: 1 },
      source: origin.routeKey, target: origin.navigatorKey });
    else router.replace('/');
  }, [navigation, origin, router]);
  useFocusEffect(useCallback(() => {
    let current = true;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!current || !navigation.isFocused()) return false;
      const entry = navigation.getState()?.routes.find(value => value.key === origin.routeKey);
      if (!entry || (entry.state?.index ?? 0) > 0) return false;
      if (pathname !== '/sample' && pathname !== '/sample/') router.replace('/sample');
      else void session.close().catch(() => {});
      return true;
    });
    return () => { current = false; listener.remove(); };
  }, [navigation, origin.routeKey, pathname, router, session]));
  return <SampleHost leave={leave}>
    <Stack screenOptions={{ presentation: 'card', headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Boards' }} />
      <Stack.Screen name="boards/[boardId]/check-ins/new" options={{ headerShown: false }} />
      <Stack.Screen name="boards/[boardId]/check-ins/[checkInId]" options={{ headerShown: false }} />
    </Stack>
  </SampleHost>;
}
