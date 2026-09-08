import { act, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import { getCoinTotals } from '@/core/domain/coin-queries';
import { createReward } from '@/core/domain/reward-commands';
import type { RewardId } from '@/core/domain/ids';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function earn(count: number) {
  const deps = await core();
  const result = await createBoard(deps, { commandId: newCommandId(), title: 'Practice', kind: 'count',
    earnsCoins: true, coinCapPerDay: 10, symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
    tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!result.ok) throw new Error(result.error.message);
  for (let i = 0; i < count; i++) expect((await createCheckIn(deps, {
    commandId: newCommandId(), boardId: result.value.boardId, source: 'app',
  })).ok).toBe(true);
}
async function reward(title: string, costCoins = 1) {
  const result = await createReward(await core(), { commandId: newCommandId(), title, costCoins,
    symbol: 'star.fill', accentHex: '#70A7FF' });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.rewardId;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function savedReward() {
  const row = await (await core()).db.getFirstAsync<{ id: RewardId; title: string; cost_coins: number; symbol: string; accent_hex: string }>(
    'SELECT id, title, cost_coins, symbol, accent_hex FROM rewards WHERE deleted_at IS NULL');
  if (!row) throw new Error('expected a saved reward');
  return row;
}

describe('reward routes and stored history', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });
  async function confirm(text: string) {
    const call = alert.mock.calls.at(-1);
    expect(call).toBeDefined();
    const button = call![2]?.find((button: { text: string }) => button.text === text);
    expect(button).toBeDefined();
    alert.mockClear();
    act(() => button.onPress());
    await settle();
  }

  it('creates a reward through the empty state, confirms its cost, then preserves its claim after editing and deletion', async () => {
    await earn(3);
    renderRouter('src/app', { initialUrl: '/coins' });
    expect(await screen.findByTestId('rewards-empty')).toBeOnTheScreen();
    await press('create-reward');
    expect(screen).toHavePathname('/coins/rewards/new');
    await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Afternoon tea');
    fireEvent.changeText(screen.getByTestId('reward-cost-input'), '2');
    await press('open-symbol-picker');
    fireEvent.changeText(screen.getByTestId('symbol-search'), 'coffee');
    await press('symbol-cup.and.saucer.fill');
    expect(screen.getByLabelText('Choose icon, Coffee')).toBeOnTheScreen();
    await press('color-green');
    await press('reward-form-save');
    expect(screen).toHavePathname('/coins');
    const saved = await savedReward();
    expect(saved).toMatchObject({ title: 'Afternoon tea', cost_coins: 2, symbol: 'cup.and.saucer.fill', accent_hex: '#78D98B' });
    await press(`claim-reward-${saved.id}`);
    const confirmation = alert.mock.calls.at(-1)!;
    expect(`${confirmation[0]} ${confirmation[1]}`).toContain('Afternoon tea');
    expect(confirmation[1]).toMatch(/\b2 coins\b/);
    expect(confirmation[1]).toMatch(/balance after claim:\s*1 coin\b/i);
    expect(await (await core()).db.getAllAsync("SELECT * FROM coin_ledger WHERE kind = 'claim'")).toEqual([]);
    await confirm('Claim');
    expect(await screen.findByTestId('coins-balance')).toHaveTextContent('1');
    const claims = await (await core()).db.getAllAsync<{ id: string; delta: number; reward_title_snapshot: string }>(
      "SELECT id, delta, reward_title_snapshot FROM coin_ledger WHERE kind = 'claim'");
    expect(claims).toEqual([{ id: expect.any(String), delta: -2, reward_title_snapshot: 'Afternoon tea' }]);
    await press(`edit-reward-${saved.id}`);
    expect(await screen.findByTestId('reward-title-input')).toHaveProp('value', 'Afternoon tea');
    expect(screen.getByLabelText('Choose icon, Coffee')).toBeOnTheScreen();
    expect(screen.getByTestId('color-green')).toBeSelected();
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'A longer break');
    fireEvent.changeText(screen.getByTestId('reward-cost-input'), '8');
    await press('reward-form-save');
    await press(`edit-reward-${saved.id}`);
    await screen.findByTestId('delete-reward');
    await press('delete-reward');
    await confirm('Delete');
    expect(await screen.findByTestId('rewards-empty')).toBeOnTheScreen();
    await press('coins-history-link');
    const history = await screen.findByTestId(`coin-history-row-${claims[0].id}`);
    expect(history).toHaveTextContent('Afternoon tea', { exact: false });
    expect(history).toHaveTextContent('-2', { exact: false });
    expect(within(history).queryByText('A longer break')).toBeNull();
    expect(await getCoinTotals(await core())).toEqual({ ok: true, value: { earned: 3, spent: 2, balance: 1 } });
  });

  it('retains invalid cost input without saving, supports code-point titles, and discards a dirty draft only after confirmation', async () => {
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId('rewards-empty'); await press('create-reward');
    await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'A treat');
    for (const value of ['', '0', '1.5', '1e2', '100001']) {
      fireEvent.changeText(screen.getByTestId('reward-cost-input'), value);
      await press('reward-form-save');
      expect(await screen.findByTestId('reward-form-error')).toBeOnTheScreen();
      expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', value);
      expect(await (await core()).db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    }
    fireEvent.changeText(screen.getByTestId('reward-title-input'), String.fromCodePoint(0x10400).repeat(80));
    fireEvent.changeText(screen.getByTestId('reward-cost-input'), '100000');
    await press('reward-form-save');
    expect((await savedReward()).title).toBe(String.fromCodePoint(0x10400).repeat(80));
    await press('create-reward'); await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Unfinished');
    act(() => router.back()); await settle();
    await confirm('Keep Editing');
    expect(screen).toHavePathname('/coins/rewards/new');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Unfinished');
    act(() => router.back()); await settle();
    await confirm('Discard');
    expect(screen).toHavePathname('/coins');
    expect(await (await core()).db.getAllAsync('SELECT * FROM rewards')).toHaveLength(1);
  });

  it('archives and restores through readable archive state, and persists accessible reordering', async () => {
    const first = await reward('First'); const second = await reward('Second');
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`reward-row-${first}`);
    await press('rewards-edit');
    await press(`reward-move-up-${second}`);
    expect(screen.getAllByTestId(/^reward-row-/).map(row => row.props.testID)).toEqual([`reward-row-${second}`, `reward-row-${first}`]);
    expect(await (await core()).db.getAllAsync('SELECT id FROM rewards WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY order_key, id'))
      .toEqual([{ id: second }, { id: first }]);
    await press(`edit-reward-${second}`); await screen.findByTestId('archive-reward');
    await press('archive-reward'); await confirm('Archive');
    expect(screen.queryByTestId(`reward-row-${second}`)).toBeNull();
    await press('rewards-archived');
    await screen.findByTestId(`reward-row-${second}`);
    expect(screen.queryByTestId(`claim-reward-${second}`)).toBeNull();
    await press(`edit-reward-${second}`);
    expect(await screen.findByTestId('restore-reward')).toBeOnTheScreen();
    expect(screen.queryByTestId('reward-form-save')).toBeNull();
    await press('restore-reward');
    await press('rewards-active');
    await screen.findByTestId(`reward-row-${second}`);
    expect(screen.getAllByTestId(/^reward-row-/).map(row => row.props.testID)).toEqual([`reward-row-${first}`, `reward-row-${second}`]);
    expect(await (await core()).db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });
});
