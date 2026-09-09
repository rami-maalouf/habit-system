import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { Text } from 'react-native';

import * as commands from '@/core/domain/anchor-settings-commands';
import * as queries from '@/core/domain/queries';
import { AnchorsScreen } from '@/features/settings/anchors-screen';
import { AnchorMinutePicker } from '@/features/anchors/anchor-minute-picker';
import { formatMinuteOfDay } from '@/features/reminders/weekdays';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { ProductPressable } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('anchor settings operation ownership', () => {
  let h: TestHarness, owner: OperationOwner;
  beforeEach(async () => { h = await createTestHarness(); owner = createOperationOwner(h.deps, { kind: 'sample-disabled' }); });
  afterEach(async () => { cleanup(); await owner.suspend(); jest.restoreAllMocks(); await h.db.closeAsync(); });
  async function open() {
    function Root() { return <ThemeProvider value={DefaultTheme}><ProductProvider owner={owner}><Stack /></ProductProvider></ThemeProvider>; }
    renderRouter({ _layout: Root, index: AnchorsScreen, cover: () => <Text>Cover</Text> });
    await settle(); await press('anchor-wake');
    act(() => screen.UNSAFE_getByType(AnchorMinutePicker).props.onChange(450)); await settle();
  }
  async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
  function callback(id: string) {
    return screen.UNSAFE_getAllByType(ProductPressable).find(node => node.props.testID === id)!.props.onPress as () => void;
  }
  async function receipts() { return h.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id'); }
  async function retire(mode: 'scope' | 'cover' | 'remove') {
    if (mode === 'scope') {
      await act(async () => { await owner.suspend(); }); act(() => owner.resume()); await settle();
    } else {
      act(() => mode === 'cover' ? router.push('/cover') : router.replace('/cover')); await settle();
      if (mode === 'cover') { act(() => router.back()); await settle(); }
    }
  }

  it('joins the accepted raw save and retains its completion across suspension', async () => {
    await open(); const entered = gate(), response = gate(); const actual = commands.setAnchorPresetMinute;
    const save = jest.spyOn(commands, 'setAnchorPresetMinute').mockImplementationOnce(async (core, input) => {
      const result = await actual(core, input); entered.resolve(); await response.promise; return result;
    });
    const old = callback('anchor-save'); act(() => { old(); old(); }); await entered.promise;
    let joined = false, joining!: Promise<void>;
    act(() => { joining = owner.suspend().then(() => { joined = true; }); }); await settle();
    const premature = joined;
    await act(async () => { response.resolve(); await joining; }); await settle();
    expect(premature).toBe(false); expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][0]).toBe(h.deps);
    const before = await receipts(); act(() => owner.resume()); await settle(); act(() => old()); await settle();
    expect(await receipts()).toEqual(before); expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
    expect(screen.getByTestId('anchor-wake')).toHaveTextContent(formatMinuteOfDay(450), { exact: false });
  });

  it.each(['scope', 'cover', 'remove'] as const)('rejects old Save, picker, Cancel and row callbacks after %s retirement', async mode => {
    await open(); const oldSave = callback('anchor-save'), oldCancel = callback('anchor-cancel'), oldRow = callback('anchor-lunch');
    const oldPicker = screen.UNSAFE_getByType(AnchorMinutePicker).props.onChange;
    const before = await receipts(); await retire(mode);
    act(() => { oldPicker(0); oldCancel(); oldRow(); oldSave(); }); await settle();
    expect(await receipts()).toEqual(before);
    if (mode !== 'remove') {
      expect(screen.getByTestId('anchor-minute-picker')).toHaveAccessibilityValue({ text: formatMinuteOfDay(450) });
      await press('anchor-save');
      expect(await queries.getAppSettings(h.deps)).toMatchObject({ ok: true, value: { wakeMinute: 450, lunchMinute: 720 } });
    }
  });

  it('retains an uncertain save through resumed read failure and retries its receipt without overwriting a later change', async () => {
    await open(); const actual = commands.setAnchorPresetMinute;
    const save = jest.spyOn(commands, 'setAnchorPresetMinute').mockImplementationOnce(async (core, input) => {
      await actual(core, input); throw Error('response lost after commit');
    });
    await press('anchor-save');
    const queryFailure = jest.spyOn(queries, 'getAppSettings').mockImplementation(async core => {
      await core.db.getAllAsync('SELECT * FROM missing_anchor_settings_table');
      throw Error('unreachable');
    });
    await retire('scope');
    expect(screen.getByTestId('anchor-save')).toHaveTextContent('Retry');
    act(() => screen.UNSAFE_getByType(AnchorMinutePicker).props.onChange(0)); await settle();
    expect(screen.getByTestId('anchor-minute-picker')).toHaveAccessibilityValue({ text: formatMinuteOfDay(450) });
    expect((await actual(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 480 })).ok).toBe(true);
    const before = await receipts(); queryFailure.mockRestore(); await press('anchor-save');
    expect(save.mock.calls[1][1]).toEqual(save.mock.calls[0][1]); expect(await receipts()).toEqual(before);
    expect(await queries.getAppSettings(h.deps)).toMatchObject({ ok: true, value: { wakeMinute: 480 } });
    expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
  });

  it('releases Save after an id source failure and permits a fresh successful attempt', async () => {
    await open(); const before = await receipts();
    jest.spyOn(h.ids, 'uuid').mockImplementationOnce(() => { throw Error('id source failure'); });
    await press('anchor-save');
    expect(screen.getByTestId('anchor-error')).toHaveTextContent('The anchor time could not be saved. Try again.');
    expect(screen.getByTestId('anchor-save')).not.toBeDisabled();
    expect(screen.getByTestId('anchor-cancel')).not.toBeDisabled();
    expect(await receipts()).toEqual(before);
    await press('anchor-save');
    expect(await queries.getAppSettings(h.deps)).toMatchObject({ ok: true, value: { wakeMinute: 450 } });
  });
});
