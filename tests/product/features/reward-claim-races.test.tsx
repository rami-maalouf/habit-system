import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import * as commands from '@/core/domain/reward-commands';
import * as queries from '@/core/domain/reward-queries';
import { err } from '@/core/domain/result';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function setup(coins = 3) {
  const deps = await core();
  const board = await createBoard(deps, { commandId: newCommandId(), title: 'Practice', kind: 'count',
    earnsCoins: true, coinCapPerDay: 10, symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!board.ok) throw new Error(board.error.message);
  for (let i = 0; i < coins; i++) await createCheckIn(deps, { commandId: newCommandId(), boardId: board.value.boardId, source: 'app' });
  const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'A break', costCoins: 2,
    symbol: 'star.fill', accentHex: '#70A7FF' });
  if (!created.ok) throw new Error(created.error.message);
  return { deps, rewardId: created.value.rewardId, boardId: board.value.boardId };
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function openCoins() {
  renderRouter('src/app', { initialUrl: '/' });
  await screen.findByTestId('coin-balance-pill'); await press('coin-balance-pill');
}

describe('reward confirmation and uncertain claim ownership', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  function claimButton() {
    const call = alert.mock.calls.at(-1);
    const button = call?.[2]?.find((candidate: { text: string }) => candidate.text === 'Claim');
    expect(button).toBeDefined();
    return button;
  }

  it('cancels and dismisses confirmation without allocating an id or changing storage', async () => {
    const { deps, rewardId } = await setup();
    await openCoins(); await screen.findByTestId(`claim-reward-${rewardId}`);
    const before = await deps.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id');
    const ledger = await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    const ids = jest.spyOn(deps.ids, 'uuid');
    const claim = jest.spyOn(commands, 'claimReward');
    await press(`claim-reward-${rewardId}`);
    const canceled = claimButton();
    const cancel = alert.mock.calls.at(-1)?.[2]?.find((button: { text: string }) => button.text === 'Cancel');
    expect(cancel).toBeDefined();
    act(() => cancel.onPress()); await settle();
    act(() => canceled.onPress()); await settle();
    await press(`claim-reward-${rewardId}`);
    const dismissed = claimButton();
    const options = alert.mock.calls.at(-1)?.[3];
    expect(options).toMatchObject({ cancelable: true, onDismiss: expect.any(Function) });
    act(() => options.onDismiss()); await settle();
    act(() => dismissed.onPress()); await settle();
    expect(claim).not.toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();
    expect(await deps.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id')).toEqual(before);
    expect(await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(ledger);
    await press(`claim-reward-${rewardId}`);
    expect(claimButton()).toBeDefined();
  });

  it('refuses an unaffordable preview without allocating a claim or changing the ledger', async () => {
    const { deps, rewardId } = await setup(1);
    await openCoins(); await screen.findByTestId(`claim-reward-${rewardId}`);
    const ids = jest.spyOn(deps.ids, 'uuid');
    const claim = jest.spyOn(commands, 'claimReward');
    const before = await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    await press(`claim-reward-${rewardId}`);
    const explanation = await screen.findByTestId('reward-claim-error');
    expect(explanation).toHaveTextContent('2 coins', { exact: false });
    expect(explanation).toHaveTextContent('1 coin', { exact: false });
    expect(alert.mock.calls.some(call => call[2]?.some((button: { text: string }) => button.text === 'Claim'))).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    // refreshing the list may allocate only the provider's existing reminder-reconcile receipt.
    for (const allocated of ids.mock.results) {
      expect(await deps.db.getFirstAsync('SELECT outcome FROM command_receipts WHERE command_id = ?', [allocated.value]))
        .toEqual({ outcome: '{"ok":true,"value":{"updated":0}}' });
    }
    expect(await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(before);
  });

  it('cannot submit a held native confirmation after its screen has unmounted', async () => {
    const { deps, rewardId } = await setup();
    const claim = jest.spyOn(commands, 'claimReward');
    await openCoins(); await press(`claim-reward-${rewardId}`);
    const held = claimButton();
    act(() => router.back()); await settle();
    act(() => held.onPress()); await settle();
    expect(claim).not.toHaveBeenCalled();
    expect(await deps.db.getAllAsync("SELECT * FROM coin_ledger WHERE kind = 'claim'")).toEqual([]);
  });

  it('shows the actual receipt balance when earnings change during confirmation', async () => {
    const { deps, rewardId, boardId } = await setup();
    await openCoins(); await press(`claim-reward-${rewardId}`);
    expect(alert.mock.calls.at(-1)?.[1]).toMatch(/balance after claim:\s*1 coin\b/i);
    const held = claimButton();
    expect((await createCheckIn(deps, { commandId: newCommandId(), boardId, source: 'app' })).ok).toBe(true);
    act(() => held.onPress()); await settle();
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('2', { exact: true });
    expect(await deps.db.getAllAsync("SELECT delta FROM coin_ledger WHERE kind = 'claim'")).toEqual([{ delta: -2 }]);
    act(() => router.back()); await settle();
    expect(screen.getByTestId('coin-balance-pill')).toHaveProp('accessibilityLabel', 'Coin balance, 2 coins');
  });

  it('refuses a previously affordable confirmation after another claim spends its funds', async () => {
    const { deps, rewardId } = await setup();
    await openCoins(); await press(`claim-reward-${rewardId}`);
    const held = claimButton();
    const preview = await queries.getRewardClaimPreview(deps, rewardId);
    if (!preview.ok) throw new Error(preview.error.message);
    expect((await commands.claimReward(deps, { commandId: newCommandId(), rewardId,
      expectedMutationStamp: preview.value.reward.mutationStamp })).ok).toBe(true);
    const before = await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id');
    act(() => held.onPress()); await settle();
    expect(await deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id')).toEqual(before);
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('1', { exact: true });
    expect(screen.queryByTestId('reward-claim-retry')).toBeNull();
  });

  it('guards a pending preview and never prompts or submits after leaving the screen', async () => {
    const { deps, rewardId } = await setup();
    const other = await commands.createReward(deps, { commandId: newCommandId(), title: 'Another break', costCoins: 1,
      symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!other.ok) throw new Error(other.error.message);
    const actualPreview = queries.getRewardClaimPreview;
    let resolve!: (value: Awaited<ReturnType<typeof actualPreview>>) => void;
    const preview = jest.spyOn(queries, 'getRewardClaimPreview').mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const claim = jest.spyOn(commands, 'claimReward');
    await openCoins(); await screen.findByTestId(`claim-reward-${rewardId}`);
    fireEvent.press(screen.getByTestId(`claim-reward-${rewardId}`));
    fireEvent.press(screen.getByTestId(`claim-reward-${rewardId}`));
    fireEvent.press(screen.getByTestId(`claim-reward-${other.value.rewardId}`));
    expect(preview).toHaveBeenCalledTimes(1);
    act(() => router.back()); await settle();
    await act(async () => { resolve(await actualPreview(deps, rewardId)); }); await settle();
    expect(alert).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(await deps.db.getAllAsync("SELECT * FROM coin_ledger WHERE kind = 'claim'")).toEqual([]);
    await press('coin-balance-pill');
    await press(`claim-reward-${rewardId}`);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(claimButton()).toBeDefined();
  });

  it('retires a pending preview when a new form covers Coins, then permits a fresh preview on return', async () => {
    const { deps, rewardId } = await setup();
    const actualPreview = queries.getRewardClaimPreview;
    let resolve!: (value: Awaited<ReturnType<typeof actualPreview>>) => void;
    const preview = jest.spyOn(queries, 'getRewardClaimPreview').mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const claim = jest.spyOn(commands, 'claimReward');
    await openCoins(); await screen.findByTestId(`claim-reward-${rewardId}`);
    fireEvent.press(screen.getByTestId(`claim-reward-${rewardId}`));
    await press('create-reward');
    expect(screen).toHavePathname('/coins/rewards/new');
    await screen.findByTestId('reward-title-input');
    await act(async () => { resolve(await actualPreview(deps, rewardId)); }); await settle();
    expect(alert).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/coins');
    await press(`claim-reward-${rewardId}`);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(claimButton()).toBeDefined();
  });

  it('submits a frozen stamp once, refuses an intervening edit, then asks for a fresh confirmation', async () => {
    const { deps, rewardId } = await setup();
    const original = await queries.getReward(deps, rewardId);
    if (!original.ok) throw new Error(original.error.message);
    const claim = jest.spyOn(commands, 'claimReward');
    await openCoins(); await press(`claim-reward-${rewardId}`);
    const stale = claimButton();
    expect((await commands.updateReward(deps, { commandId: newCommandId(), rewardId,
      expectedMutationStamp: original.value.mutationStamp, title: 'A longer break', costCoins: 3,
      symbol: original.value.symbol, accentHex: original.value.accentHex })).ok).toBe(true);
    act(() => { stale.onPress(); stale.onPress(); }); await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0][1].expectedMutationStamp).toBe(original.value.mutationStamp);
    expect(await deps.db.getAllAsync("SELECT * FROM coin_ledger WHERE kind = 'claim'")).toEqual([]);
    await press(`claim-reward-${rewardId}`);
    expect(alert.mock.calls.at(-1)?.[1]).toMatch(/balance after claim:\s*0 coins\b/i);
    act(() => claimButton().onPress()); await settle();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[1][1].commandId).not.toBe(claim.mock.calls[0][1].commandId);
    expect(await deps.db.getAllAsync("SELECT delta, reward_title_snapshot FROM coin_ledger WHERE kind = 'claim'"))
      .toEqual([{ delta: -3, reward_title_snapshot: 'A longer break' }]);
  });

  it('keeps a submitted attempt across remount and retries its receipt after a lost response and reward deletion', async () => {
    const { deps, rewardId } = await setup();
    const other = await commands.createReward(deps, { commandId: newCommandId(), title: 'Another break', costCoins: 1,
      symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!other.ok) throw new Error(other.error.message);
    const previews = jest.spyOn(queries, 'getRewardClaimPreview');
    const actualClaim = commands.claimReward;
    let originalResult!: Awaited<ReturnType<typeof actualClaim>>;
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const claim = jest.spyOn(commands, 'claimReward').mockImplementationOnce(async (...args) => {
      const result = await actualClaim(...args);
      expect(result.ok).toBe(true);
      originalResult = result;
      await pending;
      return err('database', 'The claim response was interrupted.', { retryable: true });
    });
    await openCoins(); await press(`claim-reward-${rewardId}`);
    act(() => claimButton().onPress()); await settle();
    const submitted = { ...claim.mock.calls[0][1] };
    expect(await deps.db.getAllAsync("SELECT * FROM coin_ledger WHERE kind = 'claim'")).toHaveLength(1);
    act(() => router.back()); await settle();
    await press('coin-balance-pill');
    await screen.findByTestId(`claim-reward-${rewardId}`);
    fireEvent.press(screen.getByTestId(`claim-reward-${rewardId}`)); await settle();
    fireEvent.press(screen.getByTestId(`claim-reward-${other.value.rewardId}`)); await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(previews).toHaveBeenCalledTimes(1);
    expect((await commands.deleteReward(deps, { commandId: newCommandId(), rewardId })).ok).toBe(true);
    await act(async () => { release(); }); await settle();
    expect(await screen.findByTestId('reward-claim-retry')).toBeOnTheScreen();
    const snapshot = async () => Promise.all([
      deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id'),
      deps.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
      // query invalidation also runs the existing no-op reminder reconciler.
      deps.db.getAllAsync('SELECT * FROM command_receipts WHERE outcome <> ? ORDER BY command_id', ['{"ok":true,"value":{"updated":0}}']),
      deps.db.getAllAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'),
    ]);
    const beforeRetry = await snapshot();
    previews.mockClear();
    await press('reward-claim-retry');
    expect(previews).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[1][1]).toEqual(submitted);
    expect(await claim.mock.results[1].value).toEqual(originalResult);
    expect(await snapshot()).toEqual(beforeRetry);
    expect(await deps.db.getAllAsync("SELECT delta, reward_title_snapshot FROM coin_ledger WHERE kind = 'claim'"))
      .toEqual([{ delta: -2, reward_title_snapshot: 'A break' }]);
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('1');
    expect(screen.queryByTestId('reward-claim-retry')).toBeNull();
  });
});
