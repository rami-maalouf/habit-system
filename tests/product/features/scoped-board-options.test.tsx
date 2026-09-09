import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { Text, Switch } from 'react-native';

import { BoardOptionsScreen } from '@/features/board-configuration/board-options-screen';
import { draftStoreFor, newBoardDraft } from '@/features/board-configuration/draft-store';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner } from '@/features/product-store/operation-scope';
import { ProductPressable } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness } from '../helpers/test-db';

it.each(['pause', 'cover'] as const)('keeps captured option edits and Back retired after %s and return', async movement => {
  const h = await createTestHarness();
  const owner = createOperationOwner(h.deps, { kind: 'sample-disabled' });
  const store = draftStoreFor(owner.core);
  store.begin('form'); store.start({ ...newBoardDraft(), kind: 'count', title: 'Retained draft' }, 'form');
  function Layout() {
    return <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider></ThemeProvider>;
  }
  try {
    renderRouter({ _layout: Layout, 'sample/index': () => <Text>Sample home</Text>,
      'sample/other': () => <Text>Other sample scene</Text>,
      'sample/options': () => <BoardOptionsScreen expectedBoardId={null} />,
    }, { initialUrl: '/sample' });
    act(() => router.push('/sample/options')); await settle();
    const toggle = screen.UNSAFE_getAllByType(Switch).find(node => node.props.testID === 'metrics-toggle')!.props.onValueChange!;
    const back = screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === 'options-back')!.props.onPress!;
    const before = store.getSnapshot();
    if (movement === 'pause') await act(async () => { await owner.suspend(); });
    else { act(() => router.push('/sample/other')); await settle(); }
    act(() => toggle(false)); await settle();
    expect(store.getSnapshot()).toBe(before);
    act(() => { if (movement === 'pause') owner.resume(); else router.back(); }); await settle();
    act(() => { toggle(false); back(); }); await settle();
    expect(store.getSnapshot()).toBe(before);
    expect(screen).toHavePathname('/sample/options');
    fireEvent(screen.getByTestId('metrics-toggle'), 'valueChange', false);
    expect(store.getSnapshot().draft).toMatchObject({ title: 'Retained draft', metricsEnabled: false });
    fireEvent.press(screen.getByTestId('options-back')); await settle();
    expect(screen).toHavePathname('/sample');
    expect(await h.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
  } finally { cleanup(); await h.db.closeAsync(); }
});
