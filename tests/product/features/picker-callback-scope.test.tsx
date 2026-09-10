import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, type Href } from 'expo-router';
import { Keyboard, Text, TextInput } from 'react-native';

import { createBoard } from '@/core/domain/commands';
import type { BoardId } from '@/core/domain/ids';
import { getBoard } from '@/core/domain/queries';
import * as queries from '@/core/domain/queries';
import { AnchorPicker } from '@/features/anchors/anchor-picker';
import { AnchorMinutePicker } from '@/features/anchors/anchor-minute-picker';
import { AnchorRelationPicker } from '@/features/anchors/anchor-relation-picker';
import { BoardFormScreen } from '@/features/board-configuration/board-form-screen';
import { getDraftState } from '@/features/board-configuration/draft-store';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { ProductPressable } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

function pressCallback(id: string): () => void {
  return screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === id)!.props.onPress;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }

describe('retired native picker callback ownership', () => {
  let h: TestHarness, owner: OperationOwner, boardId: BoardId;
  beforeEach(async () => {
    h = await createTestHarness();
    const result = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title: 'Retained anchor', kind: 'count',
      symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false,
      tracksTime: false, metricsEnabled: true, startOfDayMinute: 0 });
    if (!result.ok) throw Error(result.error.message);
    boardId = result.value.boardId;
    owner = createOperationOwner(h.deps, { kind: 'sample-disabled' });
    function Root() { return <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider></ThemeProvider>; }
    renderRouter({ _layout: Root, 'sample/index': () => <Text>Sample home</Text>,
      'sample/form': () => <BoardFormScreen boardId={boardId} />,
      'sample/other': () => <Text>Covered form</Text>,
    }, { initialUrl: '/sample/form' });
    await settle();
  });
  afterEach(async () => { cleanup(); await owner.suspend(); jest.restoreAllMocks(); await h.db.closeAsync(); });
  async function cover() {
    const scope = owner.getScope();
    act(() => router.push('/sample/other' as Href)); await settle();
    act(() => router.back()); await settle();
    expect(owner.getScope()).toBe(scope);
    expect(screen.getByTestId('board-title-input').props.value).toBe('Retained anchor');
  }
  async function saveAnchor() {
    await press('anchor-picker-done'); await press('board-form-save');
    const saved = await getBoard(h.deps, boardId);
    if (!saved.ok) throw Error(saved.error.message);
    return saved.value;
  }

  it.each(['done', 'dismiss'] as const)('an old anchor parent %s cannot close a newly reopened picker or change its draft', async action => {
    await press('board-anchor-row'); await press('anchor-preset-wake');
    const old = screen.UNSAFE_getByType(AnchorPicker).props;
    await cover();
    await press('anchor-picker-cancel'); await press('board-anchor-row'); await press('anchor-preset-lunch');
    const before = getDraftState(owner.core).draft;
    const keyboard = jest.spyOn(Keyboard, 'dismiss');
    act(() => action === 'done' ? old.onDone({ kind: 'preset', relation: 'before', preset: 'sleep' }) : old.onDismiss());
    await settle();
    expect(screen.getByTestId('anchor-picker-sheet')).toBeOnTheScreen();
    expect(getDraftState(owner.core).draft).toEqual(before);
    expect(keyboard).not.toHaveBeenCalled();
    expect(await saveAnchor()).toMatchObject({ anchorKind: 'preset', anchorPreset: 'lunch', anchorRelation: 'after' });
  });

  it.each(['choose', 'relation', 'text', 'done'] as const)('a retained local anchor %s callback cannot alter the returned picker', async action => {
    await press('board-anchor-row'); await press('anchor-preset-lunch');
    const oldChoose = pressCallback('anchor-preset-wake');
    const oldDone = pressCallback('anchor-picker-done');
    const oldRelation = screen.UNSAFE_getByType(AnchorRelationPicker).props.onChange;
    const oldText = screen.UNSAFE_getAllByType(TextInput).find(node => node.props.testID === 'anchor-text-input')!.props.onChangeText;
    await cover();
    const keyboard = jest.spyOn(Keyboard, 'dismiss');
    act(() => {
      if (action === 'choose') oldChoose();
      else if (action === 'relation') oldRelation('before');
      else if (action === 'text') oldText('Retired text');
      else oldDone();
    });
    await settle();
    expect(screen.getByTestId('anchor-picker-sheet')).toBeOnTheScreen();
    expect(screen.getByTestId('anchor-text-input').props.value).toBe('');
    expect(keyboard).not.toHaveBeenCalled();
    expect(await saveAnchor()).toMatchObject({ anchorKind: 'preset', anchorPreset: 'lunch', anchorRelation: 'after' });
  });

  it.each(['open', 'change', 'cancel', 'clear', 'done'] as const)('rejects an old usual-time %s callback while preserving the current time draft', async action => {
    const oldOpen = pressCallback('usual-time-row');
    await press('usual-time-row');
    const oldChange = screen.UNSAFE_getByType(AnchorMinutePicker).props.onChange;
    const oldCancel = pressCallback('usual-time-cancel');
    const oldClear = pressCallback('usual-time-clear');
    const oldDone = pressCallback('usual-time-done');
    act(() => screen.UNSAFE_getByType(AnchorMinutePicker).props.onChange(615)); await settle();
    await cover();
    const keyboard = jest.spyOn(Keyboard, 'dismiss');
    act(() => {
      if (action === 'open') oldOpen();
      else if (action === 'change') oldChange(15);
      else if (action === 'cancel') oldCancel();
      else if (action === 'clear') oldClear();
      else oldDone();
    }); await settle();
    expect(screen.UNSAFE_getByType(AnchorMinutePicker).props.minute).toBe(615);
    expect(keyboard).not.toHaveBeenCalled();
    await press('usual-time-done'); await press('board-form-save');
    const saved = await getBoard(h.deps, boardId);
    expect(saved.ok && saved.value.usualTimeMinute).toBe(615);
  });

  it.each(['query', 'category'] as const)('rejects a captured icon %s callback after focus returns and keeps fresh selection working', async action => {
    await press('open-symbol-picker');
    const oldQuery = screen.UNSAFE_getAllByType(TextInput).find(node => node.props.testID === 'symbol-search')!.props.onChangeText;
    const oldCategory = pressCallback('icon-category-health');
    fireEvent.changeText(screen.getByTestId('symbol-search'), 'bike'); await settle();
    await cover();
    act(() => action === 'query' ? oldQuery('mouth') : oldCategory()); await settle();
    expect(screen.getByTestId('symbol-search').props.value).toBe('bike');
    expect(screen.getByTestId('symbol-bicycle')).toBeOnTheScreen();
    await press('symbol-bicycle'); await press('board-form-save');
    const saved = await getBoard(h.deps, boardId);
    expect(saved.ok && saved.value.symbol).toBe('bicycle');
  });

  it('does not let a retired Retry read choices after return, while the current Retry recovers', async () => {
    const reads = jest.spyOn(queries, 'getAnchorPickerOptions').mockRejectedValueOnce(new Error('temporary choice read failure'));
    await press('board-anchor-row');
    expect(screen.getByTestId('anchor-picker-load-error')).toBeOnTheScreen();
    const oldRetry = pressCallback('anchor-picker-retry');
    await cover(); reads.mockClear();
    act(() => oldRetry()); await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByTestId('anchor-picker-load-error')).toBeOnTheScreen();
    await press('anchor-picker-retry');
    // the mounted board summary and picker both refresh through the provider.
    expect(reads).toHaveBeenCalledTimes(2);
    await press('anchor-preset-lunch');
    expect(await saveAnchor()).toMatchObject({ anchorKind: 'preset', anchorPreset: 'lunch', anchorRelation: 'after' });
  });
});
