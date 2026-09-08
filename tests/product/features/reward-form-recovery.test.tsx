import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import * as commands from '@/core/domain/reward-commands';
import { getReward } from '@/core/domain/reward-queries';
import * as queries from '@/core/domain/reward-queries';
import { err } from '@/core/domain/result';
import { ProductPressable } from '@/features/ui';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function openNew() {
  renderRouter('src/app', { initialUrl: '/coins' });
  await screen.findByTestId('create-reward'); await press('create-reward');
  await screen.findByTestId('reward-title-input');
}

describe('reward form pending work and recovery', () => {
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it('locks rapid saves, queued fields and navigation, then replays the same create after its response is lost', async () => {
    const deps = await core();
    const actualCreate = commands.createReward;
    let originalResult!: Awaited<ReturnType<typeof actualCreate>>;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const create = jest.spyOn(commands, 'createReward').mockImplementationOnce(async (...args) => {
      const result = await actualCreate(...args);
      expect(result.ok).toBe(true);
      originalResult = result;
      await pending;
      return err('database', 'The saved reward response was interrupted.', { retryable: true });
    });
    await openNew();
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'A quiet morning');
    fireEvent.changeText(screen.getByTestId('reward-cost-input'), '7');
    const queuedTitle = screen.getByTestId('reward-title-input').props.onChangeText;
    const queuedCost = screen.getByTestId('reward-cost-input').props.onChangeText;
    const queuedSave = screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === 'reward-form-save')!.props.onPress;
    act(() => { queuedSave(); queuedSave(); queuedTitle('Changed while saving'); queuedCost('99'); });
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    const submitted = { ...create.mock.calls[0][1] };
    expect(submitted).toMatchObject({ title: 'A quiet morning', costCoins: 7 });
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'A quiet morning');
    expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', '7');
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/coins/rewards/new');
    const saved = await deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id');
    expect(saved).toHaveLength(1);
    await act(async () => { release(); }); await settle();
    expect(await screen.findByTestId('reward-form-error')).toHaveTextContent('interrupted', { exact: false });
    const snapshot = async () => Promise.all([
      deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id'),
      deps.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
      // query invalidation also runs the existing no-op reminder reconciler.
      deps.db.getAllAsync('SELECT * FROM command_receipts WHERE outcome <> ? ORDER BY command_id', ['{"ok":true,"value":{"updated":0}}']),
      deps.db.getAllAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'),
    ]);
    const beforeRetry = await snapshot();
    await press('reward-form-retry');
    expect(screen).toHavePathname('/coins');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][1]).toEqual(submitted);
    expect(await create.mock.results[1].value).toEqual(originalResult);
    expect(await snapshot()).toEqual(beforeRetry);
    expect(await deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id')).toEqual(saved);
    expect(await deps.db.getAllAsync("SELECT * FROM mutation_outbox WHERE entity_type = 'reward' AND entity_id IN (SELECT id FROM rewards)"))
      .toHaveLength(1);
  });

  it('keeps a conflicting draft until an explicit reload, then saves against the current reward', async () => {
    const deps = await core();
    const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'Original',
      costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!created.ok) throw new Error(created.error.message);
    const rewardId = created.value.rewardId;
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`edit-reward-${rewardId}`); await press(`edit-reward-${rewardId}`);
    await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'My draft');
    const original = await getReward(deps, rewardId);
    if (!original.ok) throw new Error(original.error.message);
    expect((await commands.updateReward(deps, { commandId: newCommandId(), rewardId,
      expectedMutationStamp: original.value.mutationStamp, title: 'Changed elsewhere',
      costCoins: 4, symbol: 'star.fill', accentHex: '#70A7FF' })).ok).toBe(true);
    await press('reward-form-save');
    expect(await screen.findByTestId('reward-form-conflict')).toBeOnTheScreen();
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'My draft');
    await press('reward-form-reload');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Changed elsewhere');
    expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', '4');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Reviewed reward');
    await press('reward-form-save');
    expect(screen).toHavePathname('/coins');
    expect(await getReward(deps, rewardId)).toMatchObject({ ok: true, value: { title: 'Reviewed reward', costCoins: 4 } });
  });

  it('preserves unsaved edits through a failed foreground refresh and its retry', async () => {
    const deps = await core();
    const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'Original',
      costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!created.ok) throw new Error(created.error.message);
    const rewardId = created.value.rewardId;
    const handlers = new Set<(state: AppStateStatus) => void>();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.add(handler); return { remove: () => { handlers.delete(handler); } };
    });
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`edit-reward-${rewardId}`); await press(`edit-reward-${rewardId}`);
    await screen.findByTestId('reward-title-input');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Unsaved draft');
    fireEvent.changeText(screen.getByTestId('reward-cost-input'), '6');
    const read = jest.spyOn(queries, 'getReward').mockRejectedValue(new Error('temporary reward refresh failure'));
    act(() => { for (const handler of handlers) handler('active'); }); await settle();
    expect(await screen.findByTestId('reward-load-error')).toHaveTextContent('temporary reward refresh failure');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Unsaved draft');
    expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', '6');
    read.mockRestore();
    await press('reward-load-retry');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Unsaved draft');
    expect(screen.getByTestId('reward-cost-input')).toHaveProp('value', '6');
    await press('reward-form-save');
    expect(await getReward(deps, rewardId)).toMatchObject({ ok: true, value: { title: 'Unsaved draft', costCoins: 6 } });
  });
});
