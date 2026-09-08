import { act } from '@testing-library/react-native';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import * as commands from '@/core/domain/reward-commands';
import { getReward } from '@/core/domain/reward-queries';
import { err } from '@/core/domain/result';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }

describe('reward metadata receipt recovery after the source disappears', () => {
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
  });

  it.each(['update', 'delete'] as const)('retries the original %s receipt after a lost response and a terminal foreground read', async kind => {
    const deps = await core();
    const created = await commands.createReward(deps, { commandId: newCommandId(), title: 'Original reward',
      costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!created.ok) throw new Error(created.error.message);
    const rewardId = created.value.rewardId;
    const actualUpdate = commands.updateReward;
    const actualDelete = commands.deleteReward;
    let originalResult!: Awaited<ReturnType<typeof actualUpdate>>;
    const update = jest.spyOn(commands, 'updateReward');
    const remove = jest.spyOn(commands, 'deleteReward');
    if (kind === 'update') update.mockImplementationOnce(async (...args) => {
      originalResult = await actualUpdate(...args);
      expect(originalResult.ok).toBe(true);
      return err('database', 'The saved update response was interrupted.', { retryable: true });
    });
    else remove.mockImplementationOnce(async (...args) => {
      originalResult = await actualDelete(...args);
      expect(originalResult.ok).toBe(true);
      return err('database', 'The saved delete response was interrupted.', { retryable: true });
    });
    const handlers = new Set<(state: AppStateStatus) => void>();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.add(handler); return { remove: () => { handlers.delete(handler); } };
    });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`edit-reward-${rewardId}`); await press(`edit-reward-${rewardId}`);
    await screen.findByTestId('reward-title-input');
    if (kind === 'update') {
      fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Saved update');
      fireEvent.changeText(screen.getByTestId('reward-cost-input'), '7');
      await press('reward-form-save');
      expect(await getReward(deps, rewardId)).toMatchObject({ ok: true, value: { title: 'Saved update', costCoins: 7 } });
    } else {
      await press('delete-reward');
      const confirm = alert.mock.calls.at(-1)?.[2]?.find(button => button.text === 'Delete');
      expect(confirm).toBeDefined();
      act(() => confirm?.onPress?.()); await settle();
    }
    const command = kind === 'update' ? update : remove;
    expect(command).toHaveBeenCalledTimes(1);
    const submitted = { ...command.mock.calls[0][1] };
    expect(await screen.findByTestId('reward-form-retry')).toBeOnTheScreen();
    expect(screen.getByTestId('reward-form-error')).toHaveTextContent('interrupted', { exact: false });
    // another writer may delete a successfully updated reward before the original caller recovers.
    if (kind === 'update') expect((await actualDelete(deps, { commandId: newCommandId(), rewardId })).ok).toBe(true);
    expect(await getReward(deps, rewardId)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    act(() => { for (const handler of handlers) handler('active'); }); await settle();
    expect(await screen.findByTestId('reward-load-error')).toHaveTextContent('no longer exists', { exact: false });
    expect(screen.getByTestId('reward-form-retry')).toBeOnTheScreen();
    expect(screen.queryByTestId('reward-title-input')).toBeNull();
    expect(screen.queryByTestId('reward-form-save')).toBeNull();

    const snapshot = async () => Promise.all([
      deps.db.getAllAsync('SELECT * FROM rewards ORDER BY id'),
      deps.db.getAllAsync('SELECT * FROM coin_ledger ORDER BY id'),
      deps.db.getAllAsync('SELECT * FROM mutation_outbox ORDER BY id'),
      // lifecycle invalidation may add only the inherited no-op reminder receipt.
      deps.db.getAllAsync('SELECT * FROM command_receipts WHERE outcome <> ? ORDER BY command_id', ['{"ok":true,"value":{"updated":0}}']),
      deps.db.getAllAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'),
    ]);
    const beforeRetry = await snapshot();
    await press('reward-form-retry');
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls[1][1]).toEqual(submitted);
    expect(await command.mock.results[1].value).toEqual(originalResult);
    expect(screen).toHavePathname('/coins');
    expect(await snapshot()).toEqual(beforeRetry);
    expect(await deps.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
  });
});
