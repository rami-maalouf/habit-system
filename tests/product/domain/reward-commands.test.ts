import type { Reward } from '@/core/domain/entities';
import type { RewardId } from '@/core/domain/ids';
import { createCheckIn } from '@/core/domain/commands';
import {
  archiveReward, claimReward, createReward, deleteReward, reorderReward, restoreReward, updateReward,
  type CreateRewardInput,
} from '@/core/domain/reward-commands';
import { getReward, getRewardClaimPreview, listRewards } from '@/core/domain/reward-queries';
import type { DomainResult } from '@/core/domain/result';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { getReceipt } from '@/core/persistence/repositories/support';

import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

function value<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const fields = { title: 'An afternoon out', costCoins: 2, symbol: 'star.fill', accentHex: '#70A7FF' };
const missingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as RewardId;

async function create(h: TestHarness, patch: Partial<CreateRewardInput> = {}): Promise<Reward> {
  const created = value(await createReward(h.deps, { ...fields, commandId: h.ids.nextCommandId(), ...patch }));
  return value(await getReward(h.deps, created.rewardId));
}

async function earn(h: TestHarness, count: number): Promise<void> {
  const boardId = await createBoardForTest(h, { earnsCoins: true, coinCapPerDay: 10 });
  for (let index = 0; index < count; index += 1) {
    value(await createCheckIn(h.deps, { boardId, commandId: h.ids.nextCommandId(), source: 'app' }));
  }
}

async function snapshot(db: SqlExecutor, receipts = true) {
  const tables = ['rewards', 'coin_ledger', 'app_settings', 'mutation_outbox', 'boards', 'check_ins',
    'habit_actions', 'widget_board_rows', ...(receipts ? ['command_receipts'] : [])];
  return Object.fromEntries(await Promise.all(tables.map(async (table) =>
    [table, await db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)])));
}

function failingAt(db: SqlDatabase, statement: string): SqlDatabase {
  const wrapped = Object.create(db) as SqlDatabase;
  wrapped.withExclusiveTransactionAsync = (work) => db.withExclusiveTransactionAsync((tx) => {
    const failing = Object.create(tx) as SqlExecutor;
    failing.runAsync = (sql, params) => {
      if (sql.includes(statement)) throw new Error('injected reward storage failure');
      return tx.runAsync(sql, params);
    };
    return work(failing);
  });
  return wrapped;
}

describe('reward commands through the real product store', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('starts empty, normalizes a reward and atomically writes only its metadata and receipt', async () => {
    expect(value(await listRewards(h.deps))).toEqual([]);
    const before = await snapshot(h.db);
    const commandId = h.ids.nextCommandId();
    const reward = await create(h, { commandId, title: '  A quiet afternoon  ', accentHex: '#aabbcc' });
    expect(reward).toEqual({ ...fields, id: reward.id, title: 'A quiet afternoon', accentHex: '#AABBCC',
      orderKey: 'i', archivedAt: null, deletedAt: null, createdAt: h.clock.utcMs, updatedAt: h.clock.utcMs,
      mutationStamp: expect.any(String) });
    const after = await snapshot(h.db);
    for (const table of ['boards', 'check_ins', 'habit_actions', 'widget_board_rows', 'coin_ledger']) {
      expect(after[table]).toEqual(before[table]);
    }
    expect(await h.db.getAllAsync('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox'))
      .toEqual([{ entity_type: 'reward', entity_id: reward.id, mutation_stamp: reward.mutationStamp, created_at: h.clock.utcMs }]);
    expect(JSON.parse((await getReceipt(h.db, commandId))!)).toEqual({ ok: true, value: { rewardId: reward.id } });
    expect(await createReward(h.deps, { ...fields, title: '', commandId })).toEqual({ ok: true, value: { rewardId: reward.id } });
    expect(await snapshot(h.db)).toEqual(after);
  });

  it('updates using a confirmed stamp and preserves evidence on an unchanged save or stale edit', async () => {
    const reward = await create(h);
    const unchanged = await snapshot(h.db, false);
    value(await updateReward(h.deps, { ...fields, title: ` ${fields.title} `, rewardId: reward.id,
      expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
    expect(await snapshot(h.db, false)).toEqual(unchanged);
    h.clock.advanceMinutes(1);
    const input = { ...fields, title: 'Cinema', costCoins: 3, rewardId: reward.id,
      expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() };
    value(await updateReward(h.deps, input));
    expect(value(await getReward(h.deps, reward.id))).toMatchObject({ title: 'Cinema', costCoins: 3, createdAt: reward.createdAt });
    const saved = await snapshot(h.db);
    expect(await updateReward(h.deps, input)).toEqual({ ok: true, value: undefined });
    expect(await snapshot(h.db)).toEqual(saved);
    expect(await updateReward(h.deps, { ...input, title: 'Stale', commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('claims earned coins using one immutable debit and replays after rename and deletion', async () => {
    await earn(h, 3);
    const reward = await create(h);
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toEqual({ reward, balance: 3, balanceAfterClaim: 1 });
    const input = { commandId: h.ids.nextCommandId(), rewardId: reward.id, expectedMutationStamp: reward.mutationStamp };
    const claimed = value(await claimReward(h.deps, input));
    expect(claimed).toEqual({ ledgerEntryId: expect.any(String), rewardId: reward.id,
      titleSnapshot: fields.title, costCoins: 2, logicalDate: '2026-08-30', balance: 1 });
    expect(await h.db.getFirstAsync('SELECT * FROM coin_ledger WHERE id = ?', [claimed.ledgerEntryId])).toEqual({
      id: claimed.ledgerEntryId, kind: 'claim', delta: -2, board_id: null, check_in_id: null, run_key: null,
      reward_id: reward.id, reward_title_snapshot: fields.title, reverses_id: null, scope_key: null,
      source_action_id: null, reconciliation_key: null, adjusts_id: null, provenance_json: null,
      logical_date: '2026-08-30', created_at: h.clock.utcMs, mutation_stamp: expect.any(String), deleted_at: null,
    });
    expect(value(await getReward(h.deps, reward.id))).toEqual(reward);
    value(await updateReward(h.deps, { ...fields, title: 'Later title', costCoins: 1,
      rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
    value(await deleteReward(h.deps, { rewardId: reward.id, commandId: h.ids.nextCommandId() }));
    const beforeRetry = await snapshot(h.db);
    expect(await claimReward(h.deps, input)).toEqual({ ok: true, value: claimed });
    expect(await snapshot(h.db)).toEqual(beforeRetry);
    expect(await getReward(h.deps, reward.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('serializes competing affordable claims and retains the refusal receipt after new earnings', async () => {
    await earn(h, 3);
    const reward = await create(h);
    const inputs = [0, 1].map(() => ({ rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
    const results = await Promise.all(inputs.map((input) => claimReward(h.deps, input)));
    expect(results[0]).toMatchObject({ ok: true, value: { balance: 1 } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toMatchObject({ balance: 1, balanceAfterClaim: null });
    await earn(h, 1);
    expect(await claimReward(h.deps, inputs[1])).toEqual(results[1]);
    expect(await claimReward(h.deps, { ...inputs[1], commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: true, value: { balance: 0 } });
  });

  it('rejects edited and archive-restored confirmations without changing economics', async () => {
    await earn(h, 4);
    const reward = await create(h);
    value(await updateReward(h.deps, { ...fields, title: 'Renamed', rewardId: reward.id,
      expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }));
    expect(await claimReward(h.deps, { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
    const fresh = value(await getReward(h.deps, reward.id));
    const ledger = await h.db.getAllAsync('SELECT * FROM coin_ledger');
    value(await archiveReward(h.deps, { rewardId: reward.id, commandId: h.ids.nextCommandId() }));
    value(await restoreReward(h.deps, { rewardId: reward.id, commandId: h.ids.nextCommandId() }));
    expect(await claimReward(h.deps, { rewardId: reward.id, expectedMutationStamp: fresh.mutationStamp, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual(ledger);
  });

  it('archives, restores after active rewards and deletes without altering claimed history', async () => {
    const first = await create(h);
    const second = await create(h, { title: 'Second' });
    const archive = { rewardId: first.id, commandId: h.ids.nextCommandId() };
    value(await archiveReward(h.deps, archive));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([second.id]);
    expect(value(await listRewards(h.deps, { archived: true })).map((row) => row.id)).toEqual([first.id]);
    expect(value(await getReward(h.deps, first.id)).archivedAt).toBe(h.clock.utcMs);
    const archived = await snapshot(h.db);
    value(await archiveReward(h.deps, archive));
    expect(await snapshot(h.db)).toEqual(archived);
    value(await restoreReward(h.deps, { rewardId: first.id, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([second.id, first.id]);
    value(await archiveReward(h.deps, { rewardId: first.id, commandId: h.ids.nextCommandId() }));
    value(await deleteReward(h.deps, { rewardId: first.id, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps, { archived: true }))).toEqual([]);
  });

  it.each(['INSERT INTO coin_ledger', 'INSERT INTO mutation_outbox', 'UPDATE app_settings SET hlc_', 'INSERT INTO command_receipts'])(
    'rolls back a claim failing at %s and safely retries its command', async (statement) => {
      await earn(h, 2);
      const reward = await create(h);
      const input = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() };
      const before = await snapshot(h.db);
      expect(await claimReward({ ...h.deps, db: failingAt(h.db, statement) }, input))
        .toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
      expect(await snapshot(h.db)).toEqual(before);
      expect(await claimReward(h.deps, input)).toMatchObject({ ok: true, value: { balance: 0 } });
    },
  );

  it('refuses missing rewards for all mutation paths', async () => {
    const target = () => ({ rewardId: missingId, commandId: h.ids.nextCommandId() });
    for (const command of [archiveReward, restoreReward, deleteReward]) {
      expect(await command(h.deps, target())).toMatchObject({ ok: false, error: { code: 'not_found' } });
    }
    expect(await updateReward(h.deps, { ...fields, ...target(), expectedMutationStamp: 'missing' }))
      .toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await claimReward(h.deps, { ...target(), expectedMutationStamp: 'missing' }))
      .toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await reorderReward(h.deps, { ...target(), previousRewardId: null, nextRewardId: null }))
      .toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('reorders between neighbors and treats the same position as an unchanged receipt', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((title) => create(h, { title })));
    const input = { rewardId: c.id, previousRewardId: a.id, nextRewardId: b.id, commandId: h.ids.nextCommandId() };
    value(await reorderReward(h.deps, input));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([a.id, c.id, b.id]);
    const changed = await snapshot(h.db);
    value(await reorderReward(h.deps, input));
    expect(await snapshot(h.db)).toEqual(changed);
    const unchanged = await snapshot(h.db, false);
    value(await reorderReward(h.deps, { ...input, commandId: h.ids.nextCommandId() }));
    expect(await snapshot(h.db, false)).toEqual(unchanged);
    value(await reorderReward(h.deps, { rewardId: b.id, previousRewardId: null, nextRewardId: a.id, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([b.id, a.id, c.id]);
    value(await reorderReward(h.deps, { rewardId: b.id, previousRewardId: c.id, nextRewardId: null, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([a.id, c.id, b.id]);
  });

  it.each(['i', '0', '1'.repeat(65)])('atomically rebalances an insertion into valid tied keys %s', async (key) => {
    const [a, b, c, archived] = await Promise.all(['A', 'B', 'C', 'Archived'].map((title) => create(h, { title })));
    value(await archiveReward(h.deps, { rewardId: archived.id, commandId: h.ids.nextCommandId() }));
    await h.db.runAsync('UPDATE rewards SET order_key = ? WHERE id IN (?, ?)', [key, a.id, b.id]);
    await h.db.runAsync('UPDATE rewards SET order_key = ? WHERE id = ?', [key + 'z', c.id]);
    const archivedBefore = value(await getReward(h.deps, archived.id));
    const before = await snapshot(h.db);
    const input = { rewardId: c.id, previousRewardId: a.id, nextRewardId: b.id, commandId: h.ids.nextCommandId() };
    await h.db.execAsync(`CREATE TRIGGER reward_rebalance_failure BEFORE INSERT ON mutation_outbox
      WHEN NEW.entity_type = 'reward' AND NEW.entity_id = '${b.id}'
      BEGIN SELECT RAISE(ABORT, 'later reward outbox failure'); END`);
    expect(await reorderReward(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h.db)).toEqual(before);
    await h.db.execAsync('DROP TRIGGER reward_rebalance_failure');
    value(await reorderReward(h.deps, input));
    const rows = value(await listRewards(h.deps));
    expect(rows.map((row) => row.id)).toEqual([a.id, c.id, b.id]);
    expect(new Set(rows.map((row) => row.orderKey)).size).toBe(3);
    expect(new Set(rows.map((row) => row.mutationStamp)).size).toBe(1);
    expect(value(await getReward(h.deps, archived.id))).toEqual(archivedBefore);
    expect((await snapshot(h.db)).coin_ledger).toEqual(before.coin_ledger);
  });

  it.each([
    ['title', ''], ['title', '  \n '], ['title', 'x'.repeat(81)], ['title', '\uD800'], ['title', '\uDFFF'],
    ['title', null], ['title', 17], ['symbol', null], ['symbol', 'not.in.allowlist'],
    ['accentHex', null], ['accentHex', '#abc'], ['accentHex', '#GGFFFF'],
    ['costCoins', 0], ['costCoins', -1], ['costCoins', 100001], ['costCoins', 1.5],
    ['costCoins', NaN], ['costCoins', Infinity], ['costCoins', '2'], ['costCoins', null],
  ])('rejects invalid %s input %s before any reward mutation', async (field, invalid) => {
    const reward = await create(h);
    const before = await snapshot(h.db, false);
    const input = { ...fields, [field as string]: invalid, commandId: h.ids.nextCommandId() } as CreateRewardInput;
    const generated = jest.spyOn(h.ids, 'uuid');
    expect(await createReward(h.deps, input)).toMatchObject({ ok: false, error: { code: 'validation', field } });
    expect(generated).not.toHaveBeenCalled();
    expect(await updateReward(h.deps, { ...input, rewardId: reward.id,
      expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'validation', field } });
    expect(await snapshot(h.db, false)).toEqual(before);
  });

  it('accepts scalar endpoints and saves each editable field independently', async () => {
    const reward = await create(h, { title: '🦋'.repeat(80), costCoins: 100000 });
    expect(reward.title).toBe('🦋'.repeat(80));
    let current = reward;
    for (const patch of [{ title: 'New name' }, { costCoins: 1 }, { symbol: 'gift.fill' }, { accentHex: '#AaBbCc' }]) {
      value(await updateReward(h.deps, { ...current, ...patch, rewardId: current.id,
        expectedMutationStamp: current.mutationStamp, commandId: h.ids.nextCommandId() }));
      current = value(await getReward(h.deps, current.id));
    }
    expect(current).toMatchObject({ title: 'New name', costCoins: 1, symbol: 'gift.fill', accentHex: '#AABBCC' });
  });

  it('rejects malformed command and reward identities without reading or changing a reward', async () => {
    const before = await snapshot(h.db);
    expect(await createReward(h.deps, { ...fields, commandId: 'bad' as CreateRewardInput['commandId'] }))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await snapshot(h.db)).toEqual(before);
    for (const id of [undefined, null, 7, 'bad']) {
      expect(await deleteReward(h.deps, { rewardId: id as RewardId, commandId: h.ids.nextCommandId() }))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    expect(await snapshot(h.db, false)).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'command_receipts')));
  });

  it('does not use an archived reward for editing, reordering, archiving again or claiming', async () => {
    const reward = await create(h);
    expect(await restoreReward(h.deps, { rewardId: reward.id, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'validation' } });
    value(await archiveReward(h.deps, { rewardId: reward.id, commandId: h.ids.nextCommandId() }));
    const target = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp };
    for (const operation of [
      () => updateReward(h.deps, { ...fields, ...target, commandId: h.ids.nextCommandId() }),
      () => reorderReward(h.deps, { ...target, previousRewardId: null, nextRewardId: null, commandId: h.ids.nextCommandId() }),
      () => archiveReward(h.deps, { ...target, commandId: h.ids.nextCommandId() }),
      () => claimReward(h.deps, { ...target, commandId: h.ids.nextCommandId() }),
    ]) expect(await operation()).toMatchObject({ ok: false, error: { code: 'archived' } });
  });

  it('refuses invalid or stale neighbors without silently moving the reward elsewhere', async () => {
    const [a, b, c, archived, deleted] = await Promise.all(['A', 'B', 'C', 'Archived', 'Deleted'].map((title) => create(h, { title })));
    value(await archiveReward(h.deps, { rewardId: archived.id, commandId: h.ids.nextCommandId() }));
    value(await deleteReward(h.deps, { rewardId: deleted.id, commandId: h.ids.nextCommandId() }));
    const before = await snapshot(h.db, false);
    for (const neighbors of [
      { previousRewardId: a.id, nextRewardId: b.id },
      { previousRewardId: b.id, nextRewardId: b.id },
      { previousRewardId: 'bad' as RewardId, nextRewardId: null },
      { previousRewardId: null, nextRewardId: undefined as unknown as RewardId },
    ]) {
      expect(await reorderReward(h.deps, { rewardId: a.id, ...neighbors, commandId: h.ids.nextCommandId() }))
        .toMatchObject({ ok: false, error: { code: 'validation' } });
    }
    for (const neighbors of [
      { previousRewardId: missingId, nextRewardId: null },
      { previousRewardId: archived.id, nextRewardId: null },
      { previousRewardId: deleted.id, nextRewardId: null },
      { previousRewardId: null, nextRewardId: c.id },
      { previousRewardId: b.id, nextRewardId: null },
    ]) {
      expect(await reorderReward(h.deps, { rewardId: a.id, ...neighbors, commandId: h.ids.nextCommandId() }))
        .toMatchObject({ ok: false, error: { code: 'conflict' } });
    }
    expect(await snapshot(h.db, false)).toEqual(before);
  });

  it('rebalances before a minimal key and when appending exceeds fractional depth', async () => {
    const [a, b] = await Promise.all(['A', 'B'].map((title) => create(h, { title })));
    await h.db.runAsync('UPDATE rewards SET order_key = ? WHERE id = ?', ['0', a.id]);
    value(await reorderReward(h.deps, { rewardId: b.id, previousRewardId: null, nextRewardId: a.id, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([b.id, a.id]);
    await h.db.runAsync('UPDATE rewards SET order_key = ? WHERE id = ?', ['z'.repeat(65), a.id]);
    const c = await create(h, { title: 'C' });
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([b.id, a.id, c.id]);
    value(await archiveReward(h.deps, { rewardId: c.id, commandId: h.ids.nextCommandId() }));
    await h.db.runAsync('UPDATE rewards SET order_key = ? WHERE id = ?', ['z'.repeat(65), a.id]);
    value(await restoreReward(h.deps, { rewardId: c.id, commandId: h.ids.nextCommandId() }));
    expect(value(await listRewards(h.deps)).map((row) => row.id)).toEqual([b.id, a.id, c.id]);
  });

  it('captures clock and zone after acquiring the transaction, without a board day shift', async () => {
    await earn(h, 2);
    const reward = await create(h);
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocking = h.db.withExclusiveTransactionAsync(async () => { entered(); await held; });
    await acquired;
    const now = jest.spyOn(h.clock, 'nowUtcMs');
    const zone = jest.spyOn(h.clock, 'timeZoneId');
    const input = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() };
    const pending = claimReward(h.deps, input);
    expect(now).not.toHaveBeenCalled();
    expect(zone).not.toHaveBeenCalled();
    h.clock.utcMs = Date.parse('2026-08-31T10:05:00Z');
    h.clock.zone = 'Pacific/Kiritimati';
    release();
    await blocking;
    const claimed = value(await pending);
    expect(claimed).toMatchObject({ logicalDate: '2026-09-01', balance: 0 });
    expect(now).toHaveBeenCalledTimes(1);
    expect(zone).toHaveBeenCalledTimes(1);
    expect(await h.db.getFirstAsync('SELECT created_at, logical_date FROM coin_ledger WHERE id = ?', [claimed.ledgerEntryId]))
      .toEqual({ created_at: h.clock.utcMs, logical_date: '2026-09-01' });
    now.mockImplementation(() => { throw new Error('clock unavailable'); });
    zone.mockImplementation(() => { throw new Error('zone unavailable'); });
    expect(await claimReward(h.deps, input)).toEqual({ ok: true, value: claimed });
  });

  it('refuses an old confirmation when a queued public edit commits first', async () => {
    await earn(h, 3);
    const reward = await create(h);
    let entered!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = h.db.runAsync.bind(h.db);
    const write = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE rewards')) { entered(); await held; }
      return original(sql, params);
    });
    const updating = updateReward(h.deps, { ...fields, costCoins: 3, rewardId: reward.id,
      expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() });
    await acquired;
    const pending = claimReward(h.deps, { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() });
    release();
    value(await updating);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'conflict' } });
    write.mockRestore();
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toMatchObject({ balance: 3, balanceAfterClaim: 0, reward: { costCoins: 3 } });
  });

  it('uses the actual affordable balance after other spending or earnings since preview', async () => {
    await earn(h, 3);
    const reward = await create(h);
    const cheap = await create(h, { costCoins: 1 });
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toMatchObject({ balanceAfterClaim: 1 });
    value(await claimReward(h.deps, { rewardId: cheap.id, expectedMutationStamp: cheap.mutationStamp, commandId: h.ids.nextCommandId() }));
    expect(await claimReward(h.deps, { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: true, value: { balance: 0 } });
    await earn(h, 2);
    expect(value(await getRewardClaimPreview(h.deps, reward.id))).toMatchObject({ balanceAfterClaim: 0 });
    await earn(h, 1);
    expect(await claimReward(h.deps, { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: true, value: { balance: 1 } });
  });

  it('rolls back an unreadable balance without allocating a claim and recovers with its command id', async () => {
    await earn(h, 2);
    const reward = await create(h);
    const input = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() };
    const before = await snapshot(h.db);
    const original = h.db.getFirstAsync.bind(h.db);
    const read = jest.spyOn(h.db, 'getFirstAsync').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM coin_ledger')) throw new Error('balance read failed');
      return original(sql, params);
    });
    const ids = jest.spyOn(h.ids, 'uuid');
    expect(await claimReward(h.deps, input)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(ids).not.toHaveBeenCalled();
    expect(await snapshot(h.db)).toEqual(before);
    read.mockRestore();
    expect(await claimReward(h.deps, input)).toMatchObject({ ok: true, value: { balance: 0 } });
  });

  it('rolls back id or clock failures and retries only once after recovery', async () => {
    await earn(h, 2);
    const reward = await create(h);
    const input = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp, commandId: h.ids.nextCommandId() };
    const before = await snapshot(h.db);
    const ids = { uuid: () => { throw new Error('id generation failed'); } };
    expect(await claimReward({ ...h.deps, ids }, input)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await createReward({ ...h.deps, ids }, { ...fields, commandId: h.ids.nextCommandId() }))
      .toMatchObject({ ok: false, error: { code: 'database' } });
    const clock = { nowUtcMs: () => { throw new Error('clock failed'); }, timeZoneId: () => 'UTC' };
    expect(await claimReward({ ...h.deps, clock }, input)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h.db)).toEqual(before);
    value(await claimReward(h.deps, input));
    const after = await snapshot(h.db);
    value(await claimReward(h.deps, input));
    expect(await snapshot(h.db)).toEqual(after);
  });

  it('rolls back creation or metadata writes when the record or its outbox cannot be saved', async () => {
    const input = { ...fields, commandId: h.ids.nextCommandId() };
    const empty = await snapshot(h.db);
    for (const statement of ['INSERT INTO rewards', 'INSERT INTO mutation_outbox']) {
      expect(await createReward({ ...h.deps, db: failingAt(h.db, statement) }, input))
        .toMatchObject({ ok: false, error: { code: 'database' } });
      expect(await snapshot(h.db)).toEqual(empty);
    }
    const reward = value(await getReward(h.deps, value(await createReward(h.deps, input)).rewardId));
    const target = { rewardId: reward.id, commandId: h.ids.nextCommandId() };
    const before = await snapshot(h.db);
    expect(await deleteReward({ ...h.deps, db: failingAt(h.db, 'INSERT INTO mutation_outbox') }, target))
      .toMatchObject({ ok: false, error: { code: 'database' } });
    expect(await snapshot(h.db)).toEqual(before);
    value(await deleteReward(h.deps, target));
    const deleted = await snapshot(h.db);
    value(await deleteReward(h.deps, target));
    expect(await snapshot(h.db)).toEqual(deleted);
    const again = await create(h);
    value(await archiveReward(h.deps, { rewardId: again.id, commandId: h.ids.nextCommandId() }));
    const restore = { rewardId: again.id, commandId: h.ids.nextCommandId() };
    value(await restoreReward(h.deps, restore));
    const restored = await snapshot(h.db);
    value(await restoreReward(h.deps, restore));
    expect(await snapshot(h.db)).toEqual(restored);
  });
});
