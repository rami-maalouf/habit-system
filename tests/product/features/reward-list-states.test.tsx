import { act } from '@testing-library/react-native';

import { archiveReward, createReward } from '@/core/domain/reward-commands';
import * as commands from '@/core/domain/reward-commands';
import * as queries from '@/core/domain/reward-queries';
import { ProductPressable } from '@/features/ui';

import { getProductCore, mockClock, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function reward(title: string) {
  const result = await createReward(await core(), { commandId: newCommandId(), title, costCoins: 1,
    symbol: 'star.fill', accentHex: '#70A7FF' });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.rewardId;
}

describe('reward list and route recovery', () => {
  beforeEach(() => {
    jest.restoreAllMocks(); resetProductCoreForTests(); mockClock.utcMs = Date.UTC(2026, 8, 8, 16);
  });

  it('reports a failed reward query without claiming the list is empty, then retries', async () => {
    const list = jest.spyOn(queries, 'listRewards').mockRejectedValue(new Error('temporary reward read failure'));
    renderRouter('src/app', { initialUrl: '/coins' });
    expect(await screen.findByTestId('rewards-error')).toHaveTextContent('temporary reward read failure');
    expect(screen.queryByTestId('rewards-empty')).toBeNull();
    list.mockRestore();
    await press('rewards-retry');
    expect(await screen.findByTestId('rewards-empty')).toBeOnTheScreen();
  });

  it('never presents active data as archived or lets a late archived response replace the active list', async () => {
    const deps = await core();
    const active = await reward('Active reward');
    const archived = await reward('Archived reward');
    expect((await archiveReward(deps, { commandId: newCommandId(), rewardId: archived })).ok).toBe(true);
    const actualList = queries.listRewards;
    const archivedResult = await actualList(deps, { archived: true });
    let resolve!: (result: Awaited<ReturnType<typeof actualList>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof actualList>>>(done => { resolve = done; });
    jest.spyOn(queries, 'listRewards').mockImplementation((c, input) => input?.archived ? pending : actualList(c, input));
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`reward-row-${active}`);
    await press('rewards-archived');
    expect(screen.queryByTestId(`reward-row-${active}`)).toBeNull();
    await press('rewards-active');
    await screen.findByTestId(`reward-row-${active}`);
    await act(async () => { resolve(archivedResult); }); await settle();
    expect(screen.queryByTestId(`reward-row-${archived}`)).toBeNull();
    expect(screen.getByTestId(`claim-reward-${active}`)).toBeOnTheScreen();
  });

  it('guards rapid reorder callbacks and refreshes a stale insertion point without moving another gap', async () => {
    const deps = await core();
    const first = await reward('First'); const second = await reward('Second'); const third = await reward('Third');
    const actualReorder = commands.reorderReward;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const reorder = jest.spyOn(commands, 'reorderReward').mockImplementationOnce(async (...args) => {
      await pending;
      return actualReorder(...args);
    });
    renderRouter('src/app', { initialUrl: '/coins' });
    await screen.findByTestId(`reward-row-${third}`); await press('rewards-edit');
    const queuedMove = screen.UNSAFE_getAllByType(ProductPressable).find(button => button.props.testID === `reward-move-up-${third}`)!.props.onPress;
    act(() => { queuedMove(); queuedMove(); }); await settle();
    expect(reorder).toHaveBeenCalledTimes(1);
    expect((await actualReorder(deps, { commandId: newCommandId(), rewardId: first,
      previousRewardId: third, nextRewardId: null })).ok).toBe(true);
    const before = await deps.db.getAllAsync('SELECT * FROM rewards ORDER BY order_key, id');
    await act(async () => { release(); }); await settle();
    expect(await reorder.mock.results[0].value).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await deps.db.getAllAsync('SELECT * FROM rewards ORDER BY order_key, id')).toEqual(before);
    expect(screen.getAllByTestId(/^reward-row-/).map(row => row.props.testID))
      .toEqual([`reward-row-${second}`, `reward-row-${third}`, `reward-row-${first}`]);
  });

  it.each(['not-a-reward-id', '00000000-0000-4000-8000-000000000999'])(
    'recovers from reward link %s without exposing an editable draft', async (id) => {
      renderRouter('src/app', { initialUrl: `/coins/rewards/${id}` });
      expect(await screen.findByText(/(link is not valid|reward is not available)/i)).toBeOnTheScreen();
      expect(screen.queryByTestId('reward-title-input')).toBeNull();
      expect(screen.queryByTestId('reward-form-save')).toBeNull();
      expect(await (await core()).db.getAllAsync('SELECT * FROM rewards')).toEqual([]);
    },
  );
});
