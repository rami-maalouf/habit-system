import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/foundation/app-text';
import { ProductProvider } from '@/features/product-store';
import { PrimaryButton, useScheme } from '@/features/ui/primitives';
import { semanticColor, spacing } from '@/theme';

import { SampleChrome } from './chrome';
import { useSampleSession, useSampleSnapshot } from './session-context';

// leave belongs to this route's original parent navigation entry.
export function SampleHost({ children, leave }: { children: ReactNode; leave: () => void }) {
  const session = useSampleSession();
  const snapshot = useSampleSnapshot();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const leaveRef = useRef(leave);
  const [retired, setRetired] = useState(false);
  const retirement = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const retireScenes = useCallback(() => {
    if (!retirement.current) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      retirement.current = { promise, resolve };
      setRetired(true);
    }
    return retirement.current.promise;
  }, []);
  useEffect(() => {
    // passive unmount effects of removed scenes have run before this setup.
    if (retired) retirement.current?.resolve();
  }, [retired]);
  useEffect(() => {
    let current = true;
    const replacingRetiredPresentation = session.getSnapshot().status === 'closing';
    const remove = session.registerPresentation({ retireScenes, leave: () => leaveRef.current() });
    // defer entry through effect replay; a removed route never opens memory.
    void Promise.resolve().then(async () => {
      if (!current) return;
      if (replacingRetiredPresentation) await session.close(false);
      if (!current || session.getSnapshot().status !== 'idle') return;
      retirement.current = null;
      setRetired(false);
      await session.enter();
    }).catch(() => {});
    return () => {
      current = false;
      remove();
      retirement.current?.resolve();
    };
  }, [session, retireScenes]);
  const closeSample = useCallback(() => session.close(), [session]);
  return <View testID="sample-host" style={{ flex: 1, paddingTop: insets.top, backgroundColor: semanticColor('background', scheme) }}>
    <SampleChrome always />
    {snapshot.status === 'ready' && !retired
      ? <ProductProvider owner={snapshot.owner} closeSample={closeSample}>{children}</ProductProvider>
      : <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}>
        {snapshot.status === 'error' ? <>
          <AppText variant="title2" accessibilityRole="header">Sample unavailable</AppText>
          <AppText>{snapshot.message}</AppText>
          {snapshot.canRetry && <PrimaryButton title="Try again" onPress={() => { void session.enter().catch(() => {}); }} />}
        </> : <>
          <ActivityIndicator />
          <AppText style={{ textAlign: 'center' }}>{snapshot.status === 'closing'
            ? 'Closing sample...' : 'Preparing three years of sample data...'}</AppText>
        </>}
      </View>}
  </View>;
}
