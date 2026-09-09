import { act, cleanup } from '@testing-library/react-native';
import { DefaultTheme, Stack, ThemeProvider, router, useLocalSearchParams } from 'expo-router';
import { Alert, Text } from 'react-native';

import { createBoard, createCheckIn } from '@/core/domain/commands';
import type { RewardId } from '@/core/domain/ids';
import { err } from '@/core/domain/result';
import * as commands from '@/core/domain/reward-commands';
import * as queries from '@/core/domain/reward-queries';
import { ProductProvider } from '@/features/product-store';
import { createOperationOwner, type OperationOwner } from '@/features/product-store/operation-scope';
import { RewardFormScreen } from '@/features/rewards/reward-form-screen';
import { RewardsList } from '@/features/rewards/rewards-list';
import { ProductPressable } from '@/features/ui';
import { fireEvent, renderRouter, screen, settle } from '@/testing/render';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('retained reward operation scopes', () => {
  let harness: TestHarness;
  let owner: OperationOwner;
  let rewardId: RewardId;
  let alerts: jest.SpyInstance;
  beforeEach(async () => {
    harness = await createTestHarness();
    owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const board = await createBoard(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Practice', kind: 'count',
      earnsCoins: true, coinCapPerDay: 10, symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    if (!board.ok) throw Error(board.error.message);
    for (let i = 0; i < 3; i++) expect((await createCheckIn(harness.deps,
      { commandId: harness.ids.nextCommandId(), boardId: board.value.boardId, source: 'app' })).ok).toBe(true);
    const reward = await commands.createReward(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'A break',
      costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!reward.ok) throw Error(reward.error.message);
    rewardId = reward.value.rewardId;
  });
  afterEach(async () => { cleanup(); jest.restoreAllMocks(); await harness.db.closeAsync(); });

  function Root() { return <ThemeProvider value={DefaultTheme}><Stack /></ThemeProvider>; }
  function Sample() { return <ProductProvider owner={owner} closeSample={async () => {}}><Stack /></ProductProvider>; }
  function Existing() { return <RewardFormScreen rewardId={useLocalSearchParams<{ rewardId: RewardId }>().rewardId} />; }
  async function open(path = '/sample/coins') {
    renderRouter({ _layout: Root, index: () => <Text>Real home</Text>, 'sample/_layout': Sample,
      'sample/coins/index': () => <RewardsList header={<Text>Coins</Text>} onLayout={() => {}} />,
      'sample/coins/rewards/new': () => <RewardFormScreen rewardId={null} />,
      'sample/coins/rewards/[rewardId]': Existing }, { initialUrl: path });
    await settle();
  }
  async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
  function callback(id: string) {
    const button = screen.UNSAFE_getAllByType(ProductPressable).find(item => item.props.testID === id);
    if (!button) throw Error(`missing button ${id}`);
    return button.props.onPress as () => void;
  }
  function alertAction(title: string) {
    const button = alerts.mock.calls.at(-1)?.[2]?.find((item: { text: string }) => item.text === title);
    if (!button) throw Error(`missing alert action ${title}`);
    return button.onPress as () => void;
  }
  async function snapshot() {
    const names = await harness.db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return Promise.all(names.map(async ({ name }) => [name,
      (await harness.db.getAllAsync(`SELECT * FROM "${name}"`)).map(row => JSON.stringify(row)).sort()]));
  }
  async function pause() { await act(async () => { await owner.suspend(); }); await settle(); }
  async function resume() { act(() => owner.resume()); await settle(); }

  it('joins an accepted preview through its raw read and drops its prompt and old callbacks after resume', async () => {
    const held = deferred();
    const actual = queries.getRewardClaimPreview;
    const preview = jest.spyOn(queries, 'getRewardClaimPreview').mockImplementationOnce(async (...args) => {
      await held.promise; return actual(...args);
    });
    await open();
    const oldClaim = callback(`claim-reward-${rewardId}`);
    act(oldClaim); await settle();
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    expect(preview.mock.calls[0][0]).toBe(harness.deps);
    expect(await preview.mock.results[0].value).toMatchObject({ ok: true });
    expect(alerts).not.toHaveBeenCalled();
    await resume();
    act(oldClaim); await settle();
    expect(preview).toHaveBeenCalledTimes(1);
    await press(`claim-reward-${rewardId}`);
    expect(alertAction('Claim')).toBeDefined();
  });

  it('does not join an unaccepted confirmation or revive its callbacks after pause or cover', async () => {
    await open();
    const before = await snapshot();
    const ids = jest.spyOn(harness.deps.ids, 'uuid');
    const claim = jest.spyOn(commands, 'claimReward');
    const oldClaim = callback(`claim-reward-${rewardId}`);
    await press(`claim-reward-${rewardId}`);
    const confirmation = alertAction('Claim');
    await pause(); await resume();
    act(() => { confirmation(); oldClaim(); }); await settle();
    expect(claim).not.toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    const beforeCover = callback(`claim-reward-${rewardId}`);
    await press('create-reward');
    expect(screen).toHavePathname('/sample/coins/rewards/new');
    act(() => router.back()); await settle();
    alerts.mockClear();
    act(beforeCover); await settle();
    expect(alerts).not.toHaveBeenCalled();
    await press(`claim-reward-${rewardId}`);
    expect(alertAction('Claim')).toBeDefined();
  });

  it('joins a committed claim response and preserves exact receipt retry across a retired scope', async () => {
    await open();
    const actual = commands.claimReward, held = deferred();
    let original!: Awaited<ReturnType<typeof actual>>;
    const claim = jest.spyOn(commands, 'claimReward').mockImplementationOnce(async (...args) => {
      original = await actual(...args); await held.promise;
      return err('database', 'Saved response interrupted', { retryable: true });
    });
    await press(`claim-reward-${rewardId}`);
    act(alertAction('Claim')); await settle();
    expect(original.ok).toBe(true);
    const input = structuredClone(claim.mock.calls[0][1]);
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    const oldRetry = callback('reward-claim-retry');
    const before = await snapshot();
    await resume();
    act(oldRetry); await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    await press('reward-claim-retry');
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[1][1]).toEqual(input);
    expect(await claim.mock.results[1].value).toEqual(original);
    expect(await snapshot()).toEqual(before);
    expect(screen.getByTestId('reward-claim-success')).toHaveTextContent('Claimed A break for 2 coins. Balance: 1 coin.');
  });

  it('keeps a retained draft and rejects old field, save and delete confirmation callbacks after resume', async () => {
    await open(`/sample/coins/rewards/${rewardId}`);
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Unsaved title');
    const field = screen.getByTestId('reward-title-input').props.onChangeText;
    const save = callback('reward-form-save');
    await press('delete-reward');
    const confirmation = alertAction('Delete');
    const before = await snapshot();
    const ids = jest.spyOn(harness.deps.ids, 'uuid');
    await pause(); await resume();
    act(() => { confirmation(); field('Stale overwrite'); save(); }); await settle();
    expect(await snapshot()).toEqual(before);
    expect(ids).not.toHaveBeenCalled();
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'Unsaved title');
    await press('reward-form-save');
    expect(screen).toHavePathname('/sample/coins');
    expect(await queries.getReward(harness.deps, rewardId)).toMatchObject({ ok: true, value: { title: 'Unsaved title' } });
  });

  it.each([false, true])('retains accepted create completion while paused (lost response: %s)', async lost => {
    await open('/sample/coins/rewards/new');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'One new reward');
    const actual = commands.createReward, held = deferred();
    let original!: Awaited<ReturnType<typeof actual>>;
    const create = jest.spyOn(commands, 'createReward').mockImplementationOnce(async (...args) => {
      await held.promise; original = await actual(...args);
      return lost ? err('database', 'Saved response interrupted', { retryable: true }) : original;
    });
    const oldSave = callback('reward-form-save');
    act(oldSave); await settle();
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    expect(original.ok).toBe(true);
    expect(create.mock.calls[0][0]).toBe(harness.deps);
    expect(screen).toHavePathname('/sample/coins/rewards/new');
    const input = structuredClone(create.mock.calls[0][1]);
    const before = await snapshot();
    const oldFinish = callback(lost ? 'reward-form-retry' : 'reward-form-done');
    await resume();
    act(() => { oldSave(); oldFinish(); }); await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(screen).toHavePathname('/sample/coins/rewards/new');
    await press(lost ? 'reward-form-retry' : 'reward-form-done');
    expect(screen).toHavePathname('/sample/coins');
    if (lost) {
      expect(create.mock.calls[1][1]).toEqual(input);
      expect(await create.mock.results[1].value).toEqual(original);
    } else expect(create).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  it('allows native Back from a completed retained form without an unsaved-changes prompt', async () => {
    await open(); await press('create-reward');
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'Already saved');
    const actual = commands.createReward, held = deferred();
    jest.spyOn(commands, 'createReward').mockImplementationOnce(async (...args) => {
      const result = await actual(...args); await held.promise; return result;
    });
    await press('reward-form-save');
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend(); }); await settle();
    await act(async () => { held.resolve(); await pending; }); await settle();
    await resume();
    expect(screen.getByTestId('reward-form-completed')).toBeOnTheScreen();
    const before = await snapshot();
    alerts.mockClear();
    act(() => router.back()); await settle();
    expect(alerts).not.toHaveBeenCalled();
    expect(screen).toHavePathname('/sample/coins');
    expect(await snapshot()).toEqual(before);
  });

  it.each(['archive', 'restore', 'delete'] as const)('joins accepted %s through its receipt without stale navigation', async kind => {
    if (kind === 'restore') expect((await commands.archiveReward(harness.deps,
      { commandId: harness.ids.nextCommandId(), rewardId })).ok).toBe(true);
    await open(`/sample/coins/rewards/${rewardId}`);
    const name = kind === 'archive' ? 'archiveReward' : kind === 'restore' ? 'restoreReward' : 'deleteReward';
    const actual = kind === 'archive' ? commands.archiveReward : kind === 'restore' ? commands.restoreReward : commands.deleteReward;
    const held = deferred();
    const command = jest.spyOn(commands, name).mockImplementationOnce(async (core, input) => { await held.promise; return actual(core, input); });
    await press(`${kind}-reward`);
    if (kind !== 'restore') { act(alertAction(kind === 'archive' ? 'Archive' : 'Delete')); await settle(); }
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    expect(command.mock.calls[0][0]).toBe(harness.deps);
    expect(await command.mock.results[0].value).toMatchObject({ ok: true });
    const reward = await harness.db.getFirstAsync<{ archived_at: number | null; deleted_at: number | null }>(
      'SELECT archived_at, deleted_at FROM rewards WHERE id = ?', [rewardId]);
    if (kind === 'archive') expect(reward!.archived_at).not.toBeNull();
    if (kind === 'restore') expect(reward!.archived_at).toBeNull();
    if (kind === 'delete') expect(reward!.deleted_at).not.toBeNull();
    expect(screen).toHavePathname(`/sample/coins/rewards/${rewardId}`);
    const before = await snapshot();
    await resume(); await press('reward-form-done');
    expect(screen).toHavePathname('/sample/coins');
    expect(await snapshot()).toEqual(before);
  });

  it('joins reload but preserves the draft when that read completes under a retired route owner', async () => {
    await open(`/sample/coins/rewards/${rewardId}`);
    fireEvent.changeText(screen.getByTestId('reward-title-input'), 'My retained draft');
    const reward = await queries.getReward(harness.deps, rewardId);
    if (!reward.ok) throw Error(reward.error.message);
    expect((await commands.updateReward(harness.deps, { ...reward.value, rewardId, commandId: harness.ids.nextCommandId(),
      expectedMutationStamp: reward.value.mutationStamp, title: 'New stored title' })).ok).toBe(true);
    await press('reward-form-save');
    expect(screen.getByTestId('reward-form-conflict')).toBeOnTheScreen();
    const oldReload = callback('reward-form-reload');
    const actual = queries.getReward, held = deferred();
    const read = jest.spyOn(queries, 'getReward').mockImplementationOnce(async (...args) => { await held.promise; return actual(...args); });
    act(oldReload); await settle();
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'My retained draft');
    await resume(); read.mockClear();
    act(oldReload); await settle();
    expect(read).not.toHaveBeenCalled();
    await press('reward-form-reload');
    expect(screen.getByTestId('reward-title-input')).toHaveProp('value', 'New stored title');
  });

  it('rejects an old reorder callback after resume and joins a newly accepted reorder', async () => {
    const created = await commands.createReward(harness.deps, { commandId: harness.ids.nextCommandId(), title: 'Second',
      costCoins: 1, symbol: 'star.fill', accentHex: '#70A7FF' });
    if (!created.ok) throw Error(created.error.message);
    await open(); await press('rewards-edit');
    const id = `reward-move-up-${created.value.rewardId}`;
    const oldMove = callback(id);
    const actual = commands.reorderReward;
    const reorder = jest.spyOn(commands, 'reorderReward');
    await pause(); await resume();
    act(oldMove); await settle();
    expect(reorder).not.toHaveBeenCalled();
    const held = deferred();
    reorder.mockRestore();
    const current = jest.spyOn(commands, 'reorderReward').mockImplementationOnce(async (...args) => { await held.promise; return actual(...args); });
    act(callback(id)); await settle();
    let joined = false;
    let pending!: Promise<void>;
    act(() => { pending = owner.suspend().then(() => { joined = true; }); }); await settle();
    const joinedBeforeRelease = joined;
    await act(async () => { held.resolve(); await pending; }); await settle();
    expect(joinedBeforeRelease).toBe(false);
    expect(await current.mock.results[0].value).toMatchObject({ ok: true });
    expect((await queries.listRewards(harness.deps, { archived: false }))).toMatchObject({ ok: true,
      value: [{ id: created.value.rewardId }, { id: rewardId }] });
  });
});
