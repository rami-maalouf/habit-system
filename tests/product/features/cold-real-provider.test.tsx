import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { err } from '@/core/domain/result';
import { ProductProvider } from '@/features/product-store';
import { SampleSession } from '@/features/sample/session';
import { SampleSessionProvider } from '@/features/sample/session-context';

jest.mock('@/features/product-store/real-runtime', () => { throw new Error('real runtime evaluated during cold sample entry'); });

it('does not evaluate real native constructors or mount real bodies when the first entry is already sample-owned', async () => {
  const session = new SampleSession(async () => err('database', 'isolated initialization error'));
  await session.enter();
  render(<SampleSessionProvider sessionOverride={session}><ProductProvider><Text>real body</Text></ProductProvider></SampleSessionProvider>);
  expect(screen.queryByText('real body')).toBeNull();
  expect(screen.getByTestId('product-suspended')).toBeOnTheScreen();
});
