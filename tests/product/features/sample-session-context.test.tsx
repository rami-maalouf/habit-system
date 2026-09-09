import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { err } from '@/core/domain/result';
import {
  SampleSessionProvider, useOptionalSampleSession, useSampleSession, useSampleSnapshot,
} from '@/features/sample/session-context';
import { SampleSession } from '@/features/sample/session';

jest.mock('@/platform/database/sample-core', () => { throw new Error('sample factory evaluated'); });
jest.mock('@/platform/database/product-core', () => { throw new Error('real opener evaluated'); });
jest.mock('@/platform/notifications', () => { throw new Error('notifications evaluated'); });
jest.mock('@/platform/widgets', () => { throw new Error('widgets evaluated'); });

function Probe() {
  const session = useSampleSession();
  const snapshot = useSampleSnapshot();
  return <Text onPress={() => { void session.enter(); }}>{JSON.stringify(snapshot)}</Text>;
}

it('mounts the root context without evaluating either database factory', async () => {
  render(<SampleSessionProvider><Probe /></SampleSessionProvider>);
  const idle = screen.getByText('{"status":"idle"}');
  await act(async () => { fireEvent.press(idle); });
  expect(screen.getByText('{"status":"error","message":"sample factory evaluated","canRetry":true}')).toBeOnTheScreen();
});

it('uses the supplied session and preserves it across provider rerenders', async () => {
  const open = jest.fn(async () => err('database', 'controlled failure'));
  const session = new SampleSession(open);
  const view = render(<SampleSessionProvider sessionOverride={session}><Probe /></SampleSessionProvider>);
  await act(async () => { await session.enter(); });
  view.rerender(<SampleSessionProvider sessionOverride={session}><Probe /></SampleSessionProvider>);
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.getByText('{"status":"error","message":"controlled failure","canRetry":true}')).toBeOnTheScreen();
});

it('keeps isolated legacy providers idle while required sample hooks reject a missing root', () => {
  function Optional() {
    const session = useOptionalSampleSession();
    const snapshot = useSampleSnapshot();
    return <Text>{`${session === null}:${snapshot.status}`}</Text>;
  }
  render(<Optional />);
  expect(screen.getByText('true:idle')).toBeOnTheScreen();
  expect(() => render(<Probe />)).toThrow('SampleSessionProvider');
});
