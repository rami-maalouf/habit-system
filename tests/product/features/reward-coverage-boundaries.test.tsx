import { act, cleanupAsync } from '@testing-library/react-native';
import { router } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import * as commands from '@/core/domain/reward-commands';
import * as queries from '@/core/domain/reward-queries';
import type { RewardId } from '@/core/domain/ids';
import { ProductPressable } from '@/features/ui';
import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '@/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

// load the complete actual route tree before individual interaction deadlines.
const routes = getMockContext('src/app');
for (const key of routes.keys()) routes(key);

async function core() {
  const opened = await getProductCore();
  if (!opened.ok) throw Error(opened.error.message);
  return opened.value;
}
async function reward(title = 'Original reward') {
  const deps = await core();
  const created = await commands.createReward(deps, { commandId: newCommandId(), title,
    costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' });
  if (!created.ok) throw Error(created.error.message);
  return { deps, rewardId: created.value.rewardId };
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
function callback(id: string) {
  const button = screen.UNSAFE_getAllByType(ProductPressable).find(item => item.props.testID === id);
  if (!button) throw Error(`missing button ${id}`);
  return button.props.onPress as () => void;
}
async function snapshot(deps: Awaited<ReturnType<typeof core>>) {
  return Promise.all([
    deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id'),
    deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id'),
    deps.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
    deps.db.getAllAsync('SELECT * FROM command_receipts ORDER BY command_id'),
    deps.db.getAllAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'),
  ]);
}
async function openReward(rewardId: RewardId) {
  renderRouter('src/app', { initialUrl: `/coins/rewards/${rewardId}` });
  await screen.findByTestId('reward-title-input'); await settle();
}
async function conflictingDraft() {
  const seeded = await reward();
  await openReward(seeded.rewardId);
  fireEvent.changeText(screen.getByTestId('reward-title-input'), 'My unsaved draft');
  const current = await queries.getReward(seeded.deps, seeded.rewardId);
  if (!current.ok) throw Error(current.error.message);
  expect((await commands.updateReward(seeded.deps, { ...current.value, commandId: newCommandId(),
    rewardId: seeded.rewardId, expectedMutationStamp: current.value.mutationStamp, title: 'Changed elsewhere' })).ok).toBe(true);
  await press('reward-form-save');
  expect(screen.getByTestId('reward-form-conflict')).toBeOnTheScreen();
  return seeded;
}

describe('reward boundary recovery through actual routes and SQLite', () => {
  beforeEach(() => {
    resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(async () => { await cleanupAsync(); jest.restoreAllMocks(); await (await core()).db.closeAsync(); });

  it.each(['archive', 'delete'] as const)('refuses a saved editor after another public command performs %s', async kind => {
    const { deps, rewardId } = await reward();
    await openReward(rewardId);
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Cannot overwrite this');
    const update = jest.spyOn(commands, 'updateReward');
    const change = kind === 'archive' ? commands.archiveReward : commands.deleteReward;
    expect((await change(deps, { commandId: newCommandId(), rewardId })).ok).toBe(true);
    const before = await snapshot(deps);
    await press('reward-form-save');
    const result = await update.mock.results[0].value;
    expect(result).toMatchObject({ ok: false,
      error: { code: kind === 'archive' ? 'archived' : 'not_found', retryable: false } });
    expect(screen.queryByTestId('reward-title-input')).toBeNull();
    expect(screen.queryByTestId('reward-form-save')).toBeNull();
    expect(screen.queryByTestId('reward-form-retry')).toBeNull();
    if (kind === 'archive') expect(screen.getByTestId('restore-reward')).toBeOnTheScreen();
    else expect(screen.getByTestId('reward-load-error')).toHaveTextContent(/no longer exists/);
    const after = await snapshot(deps);
    // a definitive refusal records only its own idempotent failure receipt.
    expect(after[3]).toHaveLength(before[3].length + 1);
    expect(after[3]).toEqual(expect.arrayContaining(before[3]));
    expect(after[3]).toContainEqual({ command_id: update.mock.calls[0][1].commandId,
      created_at: mockClock.utcMs, outcome: JSON.stringify(result) });
    expect(after.filter((_rows, index) => index !== 3)).toEqual(before.filter((_rows, index) => index !== 3));
  });

  it('retries a committed create through the header after a non-Error rejection without minting a second reward', async () => {
    const deps = await core();
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId('create-reward'); await press('create-reward');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'An unhurried walk');
    const actual = commands.createReward;
    let original!: Awaited<ReturnType<typeof actual>>;
    const create = jest.spyOn(commands, 'createReward').mockImplementationOnce(async (...args) => {
      original = await actual(...args);
      throw 'Saved response interrupted';
    });
    await press('reward-form-save');
    expect(original.ok).toBe(true);
    expect(screen.getByTestId('reward-form-error')).toHaveTextContent('Saved response interrupted');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('editable', false);
    expect(screen.getByTestId('reward-form-save')).toHaveTextContent('Retry');
    const before = await snapshot(deps);
    const input = structuredClone(create.mock.calls[0][1]);
    await press('reward-form-save');
    expect(screen).toHavePathname('/coins');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][1]).toEqual(input);
    expect(await create.mock.results[1].value).toEqual(original);
    expect(await snapshot(deps)).toEqual(before);
  });

  it('keeps a conflicting draft through a real SQL reload failure, then retires editing when the reward is deleted', async () => {
    const { deps, rewardId } = await conflictingDraft();
    const actualRead = deps.db.getFirstAsync.bind(deps.db);
    const read = jest.spyOn(deps.db, 'getFirstAsync').mockImplementation((sql, params) => {
      if (sql.includes('FROM rewards')) throw Error('held reward read failed');
      return actualRead(sql, params);
    });
    const query = jest.spyOn(queries, 'getReward');
    await press('reward-form-reload');
    expect(await query.mock.results[0].value).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(screen.getByTestId('reward-form-error')).toBeOnTheScreen();
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'My unsaved draft');
    expect(screen.getByTestId('reward-form-reload')).toBeOnTheScreen();
    read.mockRestore();
    expect((await commands.deleteReward(deps, { commandId: newCommandId(), rewardId })).ok).toBe(true);
    const before = await snapshot(deps);
    await press('reward-form-reload');
    expect(await query.mock.results[1].value).toMatchObject({ ok: false, error: { code: 'not_found', retryable: false } });
    expect(screen.queryByTestId('reward-title-input')).toBeNull();
    expect(screen.queryByTestId('reward-form-save')).toBeNull();
    expect(screen.queryByTestId('reward-form-reload')).toBeNull();
    expect(await snapshot(deps)).toEqual(before);
  });

  it('ignores a covered reload rejection and requires a fresh Reload after returning to the retained draft', async () => {
    const { deps, rewardId } = await conflictingDraft();
    let reject!: (cause: Error) => void;
    const read = jest.spyOn(queries, 'getReward').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const before = await snapshot(deps);
    await press('reward-form-reload');
    act(() => router.push('/settings')); await settle();
    await act(async () => { reject(Error('obsolete reload failure')); }); await settle();
    act(() => router.back()); await settle();
    expect(screen).toHavePathname(`/coins/rewards/${rewardId}`);
    expect(screen.queryByText('obsolete reload failure')).toBeNull();
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'My unsaved draft');
    expect(screen.getByTestId('reward-form-conflict')).toBeOnTheScreen();
    expect(await snapshot(deps)).toEqual(before);
    await press('reward-form-reload');
    expect(read.mock.calls[1][1]).toBe(rewardId);
    expect(await read.mock.results[1].value).toMatchObject({ ok: true, value: { title: 'Changed elsewhere' } });
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Changed elsewhere');
    expect(screen.queryByTestId('reward-form-conflict')).toBeNull();
  });

  it('shows a real list SQL failure and ignores retired list controls after cover and return', async () => {
    const { deps, rewardId } = await reward();
    const actual = deps.db.getAllAsync.bind(deps.db);
    const read = jest.spyOn(deps.db, 'getAllAsync').mockImplementation((sql, params) => {
      if (sql.includes('FROM rewards')) throw Error('reward list read failed');
      return actual(sql, params);
    });
    const query = jest.spyOn(queries, 'listRewards');
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId('rewards-error');
    expect(await query.mock.results[0].value).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(screen.queryByTestId('rewards-empty')).toBeNull();
    const retry = callback('rewards-retry');
    read.mockRestore();
    act(() => router.push('/settings')); await settle();
    act(() => router.back()); await settle();
    const readsBeforeOldRetry = query.mock.calls.length;
    act(retry); await settle();
    expect(query).toHaveBeenCalledTimes(readsBeforeOldRetry);
    await press('rewards-retry');
    await screen.findByTestId(`reward-row-${rewardId}`);
    const oldCreate = callback('create-reward'), oldFilter = callback('rewards-archived'), oldEdit = callback('rewards-edit');
    const before = await snapshot(deps);
    act(() => router.push('/settings')); await settle();
    act(() => router.back()); await settle();
    act(() => { oldCreate(); oldFilter(); oldEdit(); }); await settle();
    expect(screen).toHavePathname('/coins');
    expect(screen.getByTestId('rewards-archived')).toBeOnTheScreen();
    expect(screen.queryByTestId(`reward-move-up-${rewardId}`)).toBeNull();
    expect(screen.getByTestId(`reward-row-${rewardId}`)).toBeOnTheScreen();
    expect(await snapshot(deps)).toEqual(before);
  });

  it('recovers a rejected reorder and moves the first reward into the final gap with the next fresh action', async () => {
    const { deps, rewardId: first } = await reward('First');
    const { rewardId: second } = await reward('Second');
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`reward-row-${first}`); await press('rewards-edit');
    const before = await snapshot(deps);
    const reorder = jest.spyOn(commands, 'reorderReward').mockRejectedValueOnce(Error('unexpected dispatch failure'));
    await press(`reward-move-down-${first}`);
    expect(screen.getByTestId('reward-order-error')).toHaveTextContent('The reward could not be moved. Try again.');
    expect(await snapshot(deps)).toEqual(before);
    await press(`reward-move-down-${first}`);
    expect(reorder).toHaveBeenCalledTimes(2);
    expect(reorder.mock.calls[1][1]).toMatchObject({ rewardId: first, previousRewardId: second, nextRewardId: null });
    expect(await reorder.mock.results[1].value).toEqual({ ok: true, value: undefined });
    expect(screen.queryByTestId('reward-order-error')).toBeNull();
    expect(screen.getAllByTestId(/^reward-row-/).map(row => row.props.testID)).toEqual([`reward-row-${second}`, `reward-row-${first}`]);
    expect((await deps.db.getAllAsync<{ id: string }>('SELECT id FROM rewards WHERE deleted_at IS NULL ORDER BY order_key, id')).map(row => row.id)).toEqual([second, first]);
    expect(await deps.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });
});
