import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import * as commands from '@/core/domain/reward-commands';
import * as queries from '@/core/domain/reward-queries';
import { BoardSymbol } from '@/features/boards';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function reward() {
  const deps = await core();
  const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'A quiet break',
    costCoins: 1, symbol: 'star.fill', accentHex: '#70A7FF' });
  if (!created.ok) throw new Error(created.error.message);
  return { deps, rewardId: created.value.rewardId };
}
async function earnedReward() {
  const result = await reward();
  const board = await createBoard(result.deps, { commandId: newCommandId(), title: 'Practice', kind: 'count',
    earnsCoins: true, coinCapPerDay: 10, symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!board.ok) throw new Error(board.error.message);
  expect((await createCheckIn(result.deps, { commandId: newCommandId(), boardId: board.value.boardId, source: 'app' })).ok).toBe(true);
  return result;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function snapshot(deps: Awaited<ReturnType<typeof core>>) {
  return Promise.all([
    deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id'),
    deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id'),
    deps.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
    // foreground query refresh may record only the existing reminder no-op receipt.
    deps.db.getAllAsync('SELECT * FROM command_receipts WHERE outcome <> ? ORDER BY command_id', ['{"ok":true,"value":{"updated":0}}']),
    deps.db.getAllAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'),
  ]);
}

describe('reward UI errors and recovery', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  function alertButton(title: string) {
    const button = alert.mock.calls.at(-1)?.[2]?.find((candidate: { text: string }) => candidate.text === title);
    expect(button).toBeDefined();
    return button;
  }

  it('reports a thrown preview read and permits a fresh confirmation without an earlier claim', async () => {
    const { deps, rewardId } = await earnedReward();
    const preview = jest.spyOn(queries, 'getRewardClaimPreview').mockRejectedValueOnce(new Error('Preview storage is temporarily unavailable.'));
    const claim = jest.spyOn(commands, 'claimReward');
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`claim-reward-${rewardId}`);
    const before = await snapshot(deps);
    await press(`claim-reward-${rewardId}`);
    expect(await screen.findByTestId('reward-claim-error')).toHaveTextContent('Preview storage is temporarily unavailable.');
    expect(claim).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(await snapshot(deps)).toEqual(before);
    await press(`claim-reward-${rewardId}`);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('reward-claim-error')).toBeNull();
    act(() => alertButton('Claim').onPress()); await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(await deps.db.getAllAsync("SELECT delta FROM coin_ledger WHERE kind = 'claim'"))
      .toEqual([{ delta: -1 }]);
  });

  it('recovers a thrown claim response after leaving Coins by replaying the original receipt', async () => {
    const { deps, rewardId } = await earnedReward();
    const actualClaim = commands.claimReward;
    let originalResult!: Awaited<ReturnType<typeof actualClaim>>;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const claim = jest.spyOn(commands, 'claimReward').mockImplementationOnce(async (...args) => {
      originalResult = await actualClaim(...args);
      expect(originalResult.ok).toBe(true);
      await pending;
      throw new Error('Claim response was lost.');
    });
    const previews = jest.spyOn(queries, 'getRewardClaimPreview');
    renderRouter('src/app', { initialUrl: '/' });
    await screen.findByTestId('coin-balance-pill'); await press('coin-balance-pill');
    await screen.findByTestId(`claim-reward-${rewardId}`); await press(`claim-reward-${rewardId}`);
    act(() => alertButton('Claim').onPress()); await settle();
    const input = { ...claim.mock.calls[0][1] };
    act(() => router.back()); await settle();
    await act(async () => { release(); }); await settle();
    expect(screen.getByTestId('coin-balance-pill')).toHaveProp('accessibilityLabel', 'Coin balance, 0 coins');
    await press('coin-balance-pill');
    expect(await screen.findByTestId('reward-claim-error')).toHaveTextContent('Claim response was lost.');
    const before = await snapshot(deps);
    previews.mockClear();
    await press('reward-claim-retry');
    expect(previews).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[1][1]).toEqual(input);
    expect(await claim.mock.results[1].value).toEqual(originalResult);
    expect(await snapshot(deps)).toEqual(before);
    expect(screen.queryByTestId('reward-claim-retry')).toBeNull();
    expect(screen.getByTestId('reward-claim-success')).toHaveTextContent('Claimed A quiet break for 1 coin. Balance: 0 coins.');
  });

  it('retries an initial reward read without creating an empty editable draft', async () => {
    const { deps, rewardId } = await reward();
    const read = jest.spyOn(queries, 'getReward').mockRejectedValueOnce(new Error('Reward storage is busy.'));
    const before = await snapshot(deps);
    renderRouter('src/app', { initialUrl: `/coins/rewards/${rewardId}` });
    expect(await screen.findByTestId('reward-load-error')).toHaveTextContent('Reward storage is busy.');
    expect(screen.queryByTestId('reward-title-input')).toBeNull();
    expect(screen.queryByTestId('reward-form-save')).toBeNull();
    await press('reward-load-retry');
    expect(await screen.findByTestId('reward-title-input')).toHaveProp('value', 'A quiet break');
    expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', '1');
    expect(read).toHaveBeenCalledTimes(2);
    expect(await snapshot(deps)).toEqual(before);
  });

  it('keeps an invalid custom color draft for correction and persists its normalized value', async () => {
    const deps = await core();
    const create = jest.spyOn(commands, 'createReward');
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId('create-reward'); await press('create-reward');
    await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'An afternoon outside');
    await press('custom-color');
    fireEvent.changeText(screen.getByTestId('custom-color-input'), 'not-a-color');
    await press('reward-form-save');
    expect(await screen.findByTestId('reward-form-error')).toHaveTextContent(/color/i);
    expect(screen.getByTestId('custom-color-input')).toHaveProp('value', 'not-a-color');
    expect(create).not.toHaveBeenCalled();
    expect(await deps.db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    fireEvent.changeText(screen.getByTestId('custom-color-input'), '#123abc');
    await press('reward-form-save');
    expect(create).toHaveBeenCalledTimes(1);
    const saved = await queries.listRewards(deps);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value).toHaveLength(1);
    expect(saved.value[0]).toMatchObject({ title: 'An afternoon outside', accentHex: '#123ABC' });
    await press(`edit-reward-${saved.value[0].id}`);
    await screen.findByTestId('reward-title-input'); await press('custom-color');
    expect(screen.getByTestId('custom-color-input')).toHaveProp('value', '#123ABC');
    await press('custom-color');
    expect(screen.queryByTestId('custom-color-input')).toBeNull();
  });

  it.each([false, true])('keeps partial hex text out of native preview colors for an existing reward: %s', async (existing) => {
    const deps = await core();
    let rewardId: Awaited<ReturnType<typeof reward>>['rewardId'] | null = null;
    if (existing) {
      const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'Read outside',
        costCoins: 1, symbol: 'book.fill', accentHex: '#F2F2F7' });
      if (!created.ok) throw new Error(created.error.message);
      rewardId = created.value.rewardId;
    }
    renderRouter('src/app', { initialUrl: rewardId ? `/coins/rewards/${rewardId}` : '/coins/rewards/new' });
    await screen.findByTestId('reward-title-input');
    if (!existing) fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Read outside');
    await press('custom-color');
    const before = await snapshot(deps);
    fireEvent.changeText(screen.getByTestId('custom-color-input'), '#F2');
    expect(screen.getByTestId('custom-color-input')).toHaveProp('value', '#F2');
    const previewColor = () => screen.UNSAFE_getAllByType(BoardSymbol)
      .find(symbol => symbol.props.testID === 'reward-symbol-preview')!.props.color;
    expect(previewColor()).toBe('#000000');
    expect(screen.getByTestId('reward-symbol-preview-tile')).toHaveStyle({ backgroundColor: existing ? '#F2F2F7' : '#70A7FF' });
    expect(screen.getByTestId('reward-symbol-picker-tile')).toHaveStyle({ backgroundColor: existing ? '#F2F2F7' : '#70A7FF' });
    await press('reward-form-save');
    expect(await screen.findByTestId('reward-form-error')).toHaveTextContent(/color/i);
    expect(await snapshot(deps)).toEqual(before);
    fireEvent.changeText(screen.getByTestId('custom-color-input'), '#000000');
    expect(previewColor()).toBe('#FFFFFF');
    expect(screen.getByTestId('reward-symbol-preview-tile')).toHaveStyle({ backgroundColor: '#000000' });
    await press('reward-form-save');
    const saved = await queries.listRewards(deps);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value).toHaveLength(1);
    expect(saved.value[0]).toMatchObject({ title: 'Read outside', accentHex: '#000000' });
  });

  it('cancels and dismisses metadata confirmation without writes or a delayed duplicate action', async () => {
    const { deps, rewardId } = await reward();
    const archive = jest.spyOn(commands, 'archiveReward');
    const remove = jest.spyOn(commands, 'deleteReward');
    renderRouter('src/app', { initialUrl: `/coins/rewards/${rewardId}` });
    await screen.findByTestId('reward-title-input'); await settle();
    const before = await snapshot(deps);
    const ids = jest.spyOn(deps.ids, 'uuid');
    await press('archive-reward');
    const delayedArchive = alertButton('Archive');
    act(() => alertButton('Cancel').onPress()); await settle();
    act(() => delayedArchive.onPress()); await settle();
    await press('delete-reward');
    const delayedDelete = alertButton('Delete');
    const options = alert.mock.calls.at(-1)?.[3];
    expect(options).toMatchObject({ cancelable: true, onDismiss: expect.any(Function) });
    act(() => options.onDismiss()); await settle();
    act(() => delayedDelete.onPress()); await settle();
    expect(archive).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();
    expect(await snapshot(deps)).toEqual(before);
    expect(screen.getByTestId('reward-title-input')).toHaveProp('editable', true);
  });
});
