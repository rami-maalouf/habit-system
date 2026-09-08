import { act, within } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as anchorCommands from '@/core/domain/anchor-settings-commands';
import { setAnchorPresetMinute } from '@/core/domain/commands';
import { getAppSettings } from '@/core/domain/queries';
import * as queries from '@/core/domain/queries';
import { formatMinuteOfDay } from '@/features/reminders/weekdays';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function press(id: string) {
  fireEvent.press(screen.getByTestId(id));
  await settle();
}

async function select(minute: number) {
  fireEvent(screen.getByTestId('anchor-minute-picker'), 'selectionChange', minute);
  await settle();
}

async function openAnchors() {
  renderRouter('src/app', { initialUrl: '/settings' });
  await screen.findByTestId('settings-anchors');
  await press('settings-anchors');
  await screen.findByTestId('anchor-wake');
}

describe('anchor settings', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetProductCoreForTests();
  });

  it('opens from Settings with four formatted defaults and exactly 96 labeled quarter-hour choices', async () => {
    await openAnchors();
    for (const [preset, minute] of [['wake', 420], ['lunch', 720], ['dinner', 1080], ['sleep', 1380]] as const) {
      expect(screen.getByTestId(`anchor-${preset}`)).toHaveTextContent(formatMinuteOfDay(minute), { exact: false });
    }
    expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
    await press('anchor-wake');
    const picker = screen.getByRole('combobox', { name: 'Waking up time' });
    expect(picker).toHaveAccessibilityValue({ text: formatMinuteOfDay(420) });
    expect(within(picker).getAllByText(/\d/)).toHaveLength(96);
    expect(within(picker).getByText(formatMinuteOfDay(0))).toBeOnTheScreen();
    expect(within(picker).getByText(formatMinuteOfDay(1425))).toBeOnTheScreen();
  });

  it('saves each anchor independently, including midnight and 23:45, and reopens persisted values', async () => {
    await openAnchors();
    for (const [preset, minute] of [['wake', 0], ['lunch', 735], ['dinner', 1110], ['sleep', 1425]] as const) {
      await press(`anchor-${preset}`);
      await select(minute);
      await press('anchor-save');
      expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
      expect(screen.getByTestId(`anchor-${preset}`)).toHaveTextContent(formatMinuteOfDay(minute), { exact: false });
    }
    act(() => router.back());
    await settle();
    await press('settings-anchors');
    expect(await screen.findByTestId('anchor-wake')).toHaveTextContent(formatMinuteOfDay(0), { exact: false });
    expect(screen.getByTestId('anchor-sleep')).toHaveTextContent(formatMinuteOfDay(1425), { exact: false });
    expect(await getAppSettings(await core())).toMatchObject({ ok: true, value: {
      wakeMinute: 0, lunchMinute: 735, dinnerMinute: 1110, sleepMinute: 1425,
    } });
  });

  it('discards canceled or switched drafts without saving and opens only one editor', async () => {
    await openAnchors();
    const before = await getAppSettings(await core());
    await press('anchor-wake');
    await select(0);
    await press('anchor-cancel');
    expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
    expect(screen.getByTestId('anchor-wake')).toHaveTextContent(formatMinuteOfDay(420), { exact: false });
    await press('anchor-wake');
    await select(15);
    await press('anchor-wake');
    expect(screen.getByTestId('anchor-minute-picker')).toHaveAccessibilityValue({ text: formatMinuteOfDay(15) });
    await press('anchor-lunch');
    expect(screen.getAllByTestId('anchor-minute-picker')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Lunch time' })).toHaveAccessibilityValue({ text: formatMinuteOfDay(720) });
    await press('anchor-cancel');
    expect(await getAppSettings(await core())).toEqual(before);
  });

  it('preserves a concurrent change to another anchor while saving the open draft', async () => {
    await openAnchors();
    await press('anchor-wake');
    await select(450);
    const deps = await core();
    expect((await setAnchorPresetMinute(deps, { commandId: newCommandId(), preset: 'dinner', minute: 1125 })).ok).toBe(true);
    await press('anchor-save');
    expect(screen.getByTestId('anchor-dinner')).toHaveTextContent(formatMinuteOfDay(1125), { exact: false });
    expect(await getAppSettings(deps)).toMatchObject({ ok: true, value: {
      wakeMinute: 450, lunchMinute: 720, dinnerMinute: 1125, sleepMinute: 1380,
    } });
  });

  it('keeps the draft and releases Save for retry after a storage failure', async () => {
    await openAnchors();
    await press('anchor-lunch');
    await select(765);
    const db = (await core()).db;
    const failure = jest.spyOn(db, 'runAsync').mockRejectedValueOnce(new Error('simulated disk failure'));
    await press('anchor-save');
    expect(screen.getByTestId('anchor-error')).toHaveTextContent(/simulated disk failure/);
    expect(screen.getByTestId('anchor-minute-picker')).toHaveAccessibilityValue({ text: formatMinuteOfDay(765) });
    expect(screen.getByTestId('anchor-save')).not.toBeDisabled();
    expect(await getAppSettings(await core())).toMatchObject({ ok: true, value: { lunchMinute: 720 } });
    failure.mockRestore();
    await press('anchor-save');
    expect(screen.queryByTestId('anchor-error')).toBeNull();
    expect(screen.getByTestId('anchor-lunch')).toHaveTextContent(formatMinuteOfDay(765), { exact: false });
  });

  it('locks repeated Save, Cancel, row switches, and picker changes until the save finishes', async () => {
    await openAnchors();
    await press('anchor-wake');
    await select(465);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const actualSave = anchorCommands.setAnchorPresetMinute;
    const save = jest.spyOn(anchorCommands, 'setAnchorPresetMinute').mockImplementationOnce(async (deps, input) => {
      await waiting;
      return actualSave(deps, input);
    });
    const saveButton = screen.getByTestId('anchor-save');
    const cancelButton = screen.getByTestId('anchor-cancel');
    const otherRow = screen.getByTestId('anchor-lunch');
    const picker = screen.getByTestId('anchor-minute-picker');
    act(() => {
      fireEvent.press(saveButton);
      fireEvent.press(saveButton);
      fireEvent.press(cancelButton);
      fireEvent.press(otherRow);
      fireEvent(picker, 'selectionChange', 0);
    });
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('anchor-save')).toBeDisabled();
    expect(screen.getByTestId('anchor-cancel')).toBeDisabled();
    expect(screen.getByTestId('anchor-lunch')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Waking up time' })).toBeDisabled();
    expect(screen.getByTestId('anchor-minute-picker')).toHaveAccessibilityValue({ text: formatMinuteOfDay(465) });
    expect(await getAppSettings(await core())).toMatchObject({ ok: true, value: { wakeMinute: 420 } });
    await act(async () => { finish(); await waiting; });
    await settle();
    expect(screen.queryByTestId('anchor-minute-picker')).toBeNull();
    expect(screen.getByTestId('anchor-wake')).not.toBeDisabled();
    expect(await getAppSettings(await core())).toMatchObject({ ok: true, value: { wakeMinute: 465, lunchMinute: 720 } });
  });

  it('offers a load retry without inventing editable default values when the settings read fails', async () => {
    jest.spyOn(queries, 'getAppSettings').mockRejectedValueOnce(new Error('temporary read failure'));
    renderRouter('src/app', { initialUrl: '/settings/anchors' });
    expect(await screen.findByTestId('anchor-load-error')).toHaveTextContent(/Anchor times could not be loaded/);
    expect(screen.queryByTestId('anchor-wake')).toBeNull();
    await press('anchor-retry');
    expect(await screen.findByTestId('anchor-wake')).toHaveTextContent(formatMinuteOfDay(420), { exact: false });
    expect(screen.queryByTestId('anchor-load-error')).toBeNull();
  });
});
