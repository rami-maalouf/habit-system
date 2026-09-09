import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';

import { SampleSession, type SampleSnapshot } from './session';

const SessionContext = createContext<SampleSession | null>(null);
const idle: SampleSnapshot = { status: 'idle' };
const getIdle = () => idle;
const subscribeIdle = () => () => {};

export function SampleSessionProvider({ children, sessionOverride }: {
  children: ReactNode;
  sessionOverride?: SampleSession;
}) {
  const [session] = useState(() => sessionOverride ?? new SampleSession(() => {
    // load the native memory factory only after real work has been joined.
    const { openSampleCore } = require('@/platform/database/sample-core') as typeof import('@/platform/database/sample-core');
    return openSampleCore();
  }));
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useOptionalSampleSession(): SampleSession | null {
  return useContext(SessionContext);
}

export function useSampleSession(): SampleSession {
  const session = useOptionalSampleSession();
  if (!session) throw new Error('SampleSessionProvider is required.');
  return session;
}

export function useSampleSnapshot(): SampleSnapshot {
  const session = useOptionalSampleSession();
  return useSyncExternalStore(session?.subscribe ?? subscribeIdle, session?.getSnapshot ?? getIdle,
    session?.getSnapshot ?? getIdle);
}
