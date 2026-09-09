import { localWallClock } from '@/core/calendar/logical-date';
import { getCoinTotals } from '@/core/domain/coin-queries';
import { isUuidV4, type CommandId } from '@/core/domain/ids';
import type { Clock, Hashing, IdGenerator } from '@/core/domain/ports';
import { claimReward } from '@/core/domain/reward-commands';
import { listRewards } from '@/core/domain/reward-queries';
import type { DomainResult } from '@/core/domain/result';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { listUndeletedBoards } from '@/core/persistence/repositories/boards';
import { createSampleRuntime } from '@/core/sample/generator';

import { createTestHashing, NodeSqlDatabase } from '../helpers/test-db';
import recipe from './fixtures/sample-recipe.json';

const present = Date.UTC(2026, 8, 9, 16);
const zone = 'America/Toronto';
type SampleRuntime = {
  clock: Clock;
  ids: IdGenerator;
  populate(db: SqlDatabase, hashing: Hashing): Promise<DomainResult<void>>;
};
const tables = ['boards', 'check_ins', 'board_activity_periods', 'habit_actions', 'coin_ledger',
  'rewards', 'app_settings', 'mutation_outbox', 'command_receipts', 'widget_board_rows',
  'reminders', 'reminder_schedule', 'miss_alerts', 'remote_fact_inbox', 'sync_deferred',
  'sync_state', 'sync_account_bindings'] as const;

function value<T>(result: DomainResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function snapshot(db: SqlExecutor) {
  const rows = await Promise.all(tables.map(async table =>
    [table, await db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)] as const));
  return { ...Object.fromEntries(rows), schema_migrations: await db.getAllAsync(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version') };
}

async function count(db: SqlExecutor, sql: string): Promise<number> {
  return (await db.getFirstAsync<{ count: number }>(sql))!.count;
}

function createStore() {
  const runtime: SampleRuntime = createSampleRuntime();
  const db = new NodeSqlDatabase();
  const hashing = createTestHashing();
  return { ...runtime, db, hashing, deps: { db, hashing, clock: runtime.clock, ids: runtime.ids } };
}

test('fresh sample runtimes have independent deterministic continuing uuid streams', () => {
  const first: SampleRuntime = createSampleRuntime();
  const second: SampleRuntime = createSampleRuntime();
  const sequence = Array.from({ length: 64 }, () => first.ids.uuid());
  expect(sequence.every(isUuidV4)).toBe(true);
  expect(new Set(sequence).size).toBe(sequence.length);
  expect(Array.from({ length: 64 }, () => second.ids.uuid())).toEqual(sequence);
  expect(first.ids.uuid()).toBe(second.ids.uuid());
});

describe('the sample recipe through the real product store', () => {
  let first: ReturnType<typeof createStore>;
  let second: ReturnType<typeof createStore>;

  beforeAll(async () => {
    first = createStore();
    second = createStore();
    for (const store of [first, second]) {
      value(await initializeProductDatabase(store.db, store.ids, store.hashing));
      value(await store.populate(store.db, store.hashing));
    }
  }, 60_000);

  afterAll(async () => {
    await first?.db.closeAsync();
    await second?.db.closeAsync();
  });

  it('recreates exact product rows and finishes at fixed Toronto noon with continuing ids', async () => {
    expect(await snapshot(second.db)).toEqual(await snapshot(first.db));
    for (const store of [first, second]) {
      expect(store.clock.timeZoneId()).toBe(zone);
      expect(store.clock.nowUtcMs()).toBe(present);
      expect(store.clock.nowUtcMs()).toBe(present);
    }
    const next = first.ids.uuid();
    expect(next).toBe(second.ids.uuid());
    expect(isUuidV4(next)).toBe(true);
    expect(await first.db.getFirstAsync(`SELECT id FROM boards WHERE id = ?
      UNION ALL SELECT id FROM check_ins WHERE id = ?
      UNION ALL SELECT id FROM habit_actions WHERE id = ?
      UNION ALL SELECT id FROM coin_ledger WHERE id = ?
      UNION ALL SELECT id FROM rewards WHERE id = ?
      UNION ALL SELECT command_id AS id FROM command_receipts WHERE command_id = ?
      UNION ALL SELECT device_id AS id FROM app_settings WHERE device_id = ?`, Array(7).fill(next))).toBeNull();
  });

  it('matches the independently reviewed literal recipe identities, counts, claims and totals', async () => {
    for (const [table, expected] of Object.entries(recipe.tableCounts)) {
      expect(await count(first.db, `SELECT COUNT(*) AS count FROM ${table}`)).toBe(expected);
    }
    expect(await first.db.getAllAsync(`SELECT kind, delta, COUNT(*) AS count FROM coin_ledger
      GROUP BY kind, delta ORDER BY kind, delta`)).toEqual(recipe.ledgerKinds);
    expect(await first.db.getAllAsync(`SELECT id, title, kind, anchor_kind AS anchorKind,
      anchor_board_id AS anchorBoardId, anchor_preset AS anchorPreset, required_in_stack AS requiredInStack,
      coin_cap_per_day AS coinCapPerDay FROM boards ORDER BY created_at`)).toEqual(recipe.boardIdentities);
    expect(await first.db.getAllAsync('SELECT id, title, cost_coins FROM rewards ORDER BY created_at')).toEqual(recipe.rewardRows);
    expect(await first.db.getAllAsync(`SELECT id, logical_date AS logicalDate, delta, reward_id AS rewardId,
      reward_title_snapshot AS rewardTitleSnapshot, created_at AS createdAt
      FROM coin_ledger WHERE kind = 'claim' ORDER BY created_at`)).toEqual(recipe.claims);
    expect(value(await getCoinTotals(first.deps))).toEqual(recipe.totals);
  });

  it('contains seven Daily habits, one Count habit and one required four-habit wake chain', async () => {
    const boards = await listUndeletedBoards(first.db);
    expect(boards).toHaveLength(8);
    expect(boards.filter(board => board.kind === 'daily')).toHaveLength(7);
    expect(boards.filter(board => board.kind === 'count')).toHaveLength(1);
    expect(boards.every(board => board.archivedAt === null)).toBe(true);
    const roots = boards.filter(board => board.anchorKind === 'preset');
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ anchorRelation: 'after', anchorPreset: 'wake' });
    const members = [roots[0]];
    for (let index = 0; index < 3; index += 1) {
      const children = boards.filter(board => board.anchorBoardId === members[index].id);
      expect(children).toHaveLength(1);
      members.push(children[0]);
    }
    expect(new Set(members.map(board => board.id)).size).toBe(4);
    expect(members.every(board => board.kind === 'daily' && board.requiredInStack && board.earnsCoins)).toBe(true);
    expect(boards.filter(board => board.anchorKind === 'board')).toHaveLength(3);
    expect(boards.filter(board => !members.includes(board)).every(board => board.anchorKind === null)).toBe(true);
  });

  it('retains the literal leap-day check and bonus removal/recheck history', async () => {
    const rows = await first.db.getAllAsync<{ kind: string; delta: number; count: number }>(`
      SELECT l.kind, l.delta, COUNT(*) AS count FROM coin_ledger l
      JOIN habit_actions a ON a.id = l.source_action_id JOIN boards b ON b.id = a.board_id
      WHERE l.logical_date = '2024-02-29' AND b.anchor_kind IS NOT NULL
      GROUP BY l.kind, l.delta ORDER BY l.kind, l.delta`);
    expect(rows).toEqual([
      { kind: 'check', delta: 1, count: 5 },
      { kind: 'reversal', delta: -1, count: 2 },
      { kind: 'run_bonus', delta: 1, count: 2 },
    ]);
    expect(rows.reduce((balance, row) => balance + row.delta * row.count, 0)).toBe(5);
  });

  it('represents three calendar years including leap day, real gaps and a Count cap boundary', async () => {
    expect(await first.db.getFirstAsync('SELECT MIN(logical_date) AS first, MAX(logical_date) AS last FROM check_ins'))
      .toEqual({ first: '2023-09-10', last: '2026-09-09' });
    expect(await count(first.db, "SELECT COUNT(*) AS count FROM check_ins WHERE logical_date = '2024-02-29'"))
      .toBeGreaterThan(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM (
      SELECT logical_date, LAG(logical_date) OVER (PARTITION BY board_id ORDER BY logical_date) AS previous
      FROM check_ins WHERE deleted_at IS NULL AND state_suppressed = 0 GROUP BY board_id, logical_date
    ) WHERE julianday(logical_date) - julianday(previous) >= 7`)).toBeGreaterThan(0);
    const today = await count(first.db, `SELECT COUNT(DISTINCT c.board_id) AS count FROM check_ins c
      JOIN boards b ON b.id = c.board_id WHERE b.kind = 'daily' AND c.logical_date = '2026-09-09'
      AND c.deleted_at IS NULL AND c.state_suppressed = 0`);
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThan(7);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM check_ins c JOIN boards b ON b.id = c.board_id
      WHERE b.kind = 'count' AND c.amount > 0 AND c.occurred_at_utc IS NOT NULL
      AND c.time_zone_id = 'America/Toronto'`)).toBeGreaterThan(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM (
      SELECT c.logical_date FROM boards b JOIN check_ins c ON c.board_id = b.id
      LEFT JOIN coin_ledger l ON l.board_id = b.id AND l.logical_date = c.logical_date AND l.kind = 'check'
      WHERE b.kind = 'count' AND c.deleted_at IS NULL AND c.state_suppressed = 0
      GROUP BY c.logical_date, b.coin_cap_per_day
      HAVING COUNT(DISTINCT c.id) > b.coin_cap_per_day AND COUNT(DISTINCT l.id) = b.coin_cap_per_day
    )`)).toBeGreaterThan(0);
  });

  it('uses calendar labels through both Toronto DST transitions without moving a check to another date', async () => {
    const days = ['2024-03-09', '2024-03-10', '2024-11-02', '2024-11-03'];
    const rows = await first.db.getAllAsync<{ logical_date: string; created_at: number }>(`
      SELECT logical_date, created_at FROM habit_actions
      WHERE kind = 'check' AND logical_date IN (SELECT value FROM json_each(?)) ORDER BY created_at`, [JSON.stringify(days)]);
    expect(new Set(rows.map(row => row.logical_date))).toEqual(new Set(days));
    for (const row of rows) {
      const local = localWallClock(row.created_at, zone);
      expect(`${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`)
        .toBe(row.logical_date);
      expect(local.hour).toBeGreaterThanOrEqual(7);
      expect(local.hour).toBeLessThanOrEqual(21);
      const expectedOffset = ['2024-03-09', '2024-11-03'].includes(row.logical_date) ? 5 : 4;
      expect(new Date(row.created_at).getUTCHours()).toBe((local.hour + expectedOffset) % 24);
    }
  });

  it('keeps public command receipts and immutable causes for real earnings and both reversal kinds', async () => {
    expect(await count(first.db, "SELECT COUNT(*) AS count FROM habit_actions WHERE kind = 'baseline'")).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM habit_actions a
      LEFT JOIN command_receipts r ON r.command_id = a.command_id
      WHERE r.command_id IS NULL OR json_extract(r.outcome, '$.ok') IS NOT 1`)).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM check_ins c
      LEFT JOIN command_receipts r ON r.command_id = c.idempotency_key
      WHERE json_extract(r.outcome, '$.value.checkInId') IS NOT c.id`)).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM coin_ledger l
      LEFT JOIN habit_actions a ON a.id = l.source_action_id
      WHERE l.kind IN ('check', 'run_bonus', 'reversal') AND a.id IS NULL`)).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM coin_ledger r
      LEFT JOIN coin_ledger original ON original.id = r.reverses_id
      WHERE r.kind = 'reversal' AND (original.id IS NULL OR r.delta != -original.delta)`)).toBe(0);
    for (const parentKind of ['check', 'run_bonus']) {
      expect(await count(first.db, `SELECT COUNT(*) AS count FROM coin_ledger r
        JOIN coin_ledger original ON original.id = r.reverses_id
        JOIN habit_actions removal ON removal.id = r.source_action_id
        WHERE r.kind = 'reversal' AND original.kind = '${parentKind}' AND r.delta = -original.delta
        AND original.deleted_at IS NULL AND removal.kind = 'uncheck'`)).toBeGreaterThan(0);
    }
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM habit_actions a JOIN boards b ON b.id = a.board_id
      WHERE a.created_at < b.created_at OR a.created_at > ${present}`)).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM coin_ledger l JOIN habit_actions a ON a.id = l.source_action_id
      WHERE l.kind IN ('check', 'run_bonus') AND (a.policy_json IS NULL OR a.kind != 'check'
        OR (l.kind = 'check' AND a.created_at >= json_extract(a.policy_json, '$.checkClosesAtUtc'))
        OR (l.kind = 'run_bonus' AND a.created_at >= json_extract(a.policy_json, '$.bonusClosesAtUtc')))`)).toBe(0);
    for (const [table, entity] of [['habit_actions', 'habit_action'], ['coin_ledger', 'ledger_entry']]) {
      expect(await count(first.db, `SELECT COUNT(*) AS count FROM ${table} f
        LEFT JOIN mutation_outbox o ON o.entity_type = '${entity}'
          AND o.entity_id = f.id AND o.mutation_stamp = f.mutation_stamp WHERE o.id IS NULL`)).toBe(0);
    }
  });

  it('retains four rewards, actual affordable claim receipts and balance for another claim', async () => {
    const rewards = value(await listRewards(first.deps));
    expect(rewards).toHaveLength(4);
    expect(await count(first.db, "SELECT COUNT(*) AS count FROM coin_ledger WHERE kind = 'claim'"))
      .toBeGreaterThan(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM coin_ledger l
      LEFT JOIN rewards reward ON reward.id = l.reward_id
      WHERE l.kind = 'claim' AND (reward.id IS NULL OR l.reward_title_snapshot IS NULL
        OR l.created_at < reward.created_at OR NOT EXISTS (SELECT 1 FROM command_receipts r
          WHERE json_extract(r.outcome, '$.value.ledgerEntryId') = l.id AND json_extract(r.outcome, '$.ok') = 1))`)).toBe(0);
    expect(await count(first.db, `SELECT COUNT(*) AS count FROM (
      SELECT kind, SUM(delta) OVER (ORDER BY created_at, mutation_stamp, id ROWS UNBOUNDED PRECEDING) AS balance
      FROM coin_ledger
    ) WHERE kind = 'claim' AND balance < 0`)).toBe(0);
    expect(value(await getCoinTotals(first.deps)).balance).toBeGreaterThanOrEqual(
      Math.min(...rewards.map(reward => reward.costCoins)));
  });

  it('leaves local notification and remote admission state empty without erasing command evidence', async () => {
    for (const table of ['miss_alerts', 'remote_fact_inbox', 'sync_deferred', 'reminders', 'reminder_schedule']) {
      expect(await first.db.getAllAsync(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(await count(first.db, 'SELECT COUNT(*) AS count FROM command_receipts')).toBeGreaterThan(0);
    expect(await count(first.db, 'SELECT COUNT(*) AS count FROM mutation_outbox')).toBeGreaterThan(0);
    expect(await count(first.db, 'SELECT COUNT(*) AS count FROM widget_board_rows')).toBeGreaterThan(0);
    expect(await first.db.getFirstAsync('SELECT schema_revision, icloud_sync_enabled FROM app_settings'))
      .toEqual({ schema_revision: 12, icloud_sync_enabled: 0 });
  });

  it('continues public claims with fresh deterministic ids and an exact replay fixed point', async () => {
    const commands = [];
    for (const store of [first, second]) {
      const reward = value(await listRewards(store.deps)).sort((a, b) => a.costCoins - b.costCoins)[0];
      const input = { rewardId: reward.id, expectedMutationStamp: reward.mutationStamp,
        commandId: store.ids.uuid() as CommandId };
      const result = await claimReward(store.deps, input);
      expect(value(result)).toMatchObject({ logicalDate: '2026-09-09', costCoins: reward.costCoins });
      const after = await snapshot(store.db);
      expect(await claimReward(store.deps, input)).toEqual(result);
      expect(await snapshot(store.db)).toEqual(after);
      expect(store.clock.nowUtcMs()).toBe(present);
      commands.push({ input, result });
    }
    expect(commands[1]).toEqual(commands[0]);
    expect(await snapshot(second.db)).toEqual(await snapshot(first.db));
  });
});

test('a failed public command rolls back its writes and stops sample population', async () => {
  const store = createStore();
  try {
    value(await initializeProductDatabase(store.db, store.ids, store.hashing));
    let receiptAttempts = 0;
    const failing = Object.create(store.db) as SqlDatabase;
    failing.withExclusiveTransactionAsync = work => store.db.withExclusiveTransactionAsync(tx => {
      const wrapped = Object.create(tx) as SqlExecutor;
      wrapped.runAsync = (sql, params) => {
        if (sql.includes('INSERT INTO command_receipts')) {
          receiptAttempts += 1;
          throw new Error('sample command receipt storage failure');
        }
        return tx.runAsync(sql, params);
      };
      return work(wrapped);
    });
    expect(await store.populate(failing, store.hashing)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(receiptAttempts).toBe(1);
    expect(store.clock.nowUtcMs()).toBe(present);
    for (const table of ['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'rewards', 'command_receipts', 'mutation_outbox']) {
      expect(await store.db.getAllAsync(`SELECT * FROM ${table}`)).toEqual([]);
    }
  } finally {
    await store.db.closeAsync();
  }
});


test.each([
  ['rewards', 8],
  ['coin_ledger', 12],
] as const)('a %s write failure stops later seed commands and rolls back the failed command', async (table, receipts) => {
  const store = createStore();
  try {
    value(await initializeProductDatabase(store.db, store.ids, store.hashing));
    let attempts = 0;
    const failing = Object.create(store.db) as SqlDatabase;
    failing.withExclusiveTransactionAsync = work => store.db.withExclusiveTransactionAsync(tx => {
      const wrapped = Object.create(tx) as SqlExecutor;
      wrapped.runAsync = (sql, params) => {
        if (sql.includes(`INSERT INTO ${table}`)) {
          attempts += 1;
          throw new Error('sample write unavailable');
        }
        return tx.runAsync(sql, params);
      };
      return work(wrapped);
    });
    expect(await store.populate(failing, store.hashing)).toMatchObject({ ok: false, error: { code: 'database' } });
    expect(attempts).toBe(1);
    expect(await count(store.db, 'SELECT COUNT(*) AS count FROM boards')).toBe(8);
    expect(await count(store.db, 'SELECT COUNT(*) AS count FROM command_receipts')).toBe(receipts);
    expect(await store.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    expect(await store.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    expect(await count(store.db, "SELECT COUNT(*) AS count FROM habit_actions WHERE kind = 'check'")).toBe(0);
    expect(store.clock.nowUtcMs()).toBe(present);
  } finally {
    await store.db.closeAsync();
  }
});

test('an unexpected runtime port failure propagates unchanged and restores the fixed clock', async () => {
  const store = createStore();
  try {
    value(await initializeProductDatabase(store.db, store.ids, store.hashing));
    const before = await snapshot(store.db);
    const cause = new Error('sample id port unavailable');
    store.ids.uuid = () => { throw cause; };
    await expect(store.populate(store.db, store.hashing)).rejects.toBe(cause);
    expect(await snapshot(store.db)).toEqual(before);
    expect(store.clock.nowUtcMs()).toBe(present);
  } finally {
    await store.db.closeAsync();
  }
});
