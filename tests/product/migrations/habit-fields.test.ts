import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createBoard } from '@/core/domain/commands';
import { migrateDatabase, migrationChecksum } from '@/core/persistence/migrations';
import { latestSchemaVersion, migrations } from '@/core/persistence/schema';

import { createTestHarness, NodeSqlDatabase } from '../helpers/test-db';

const boardDefaults = {
  kind: 'count', anchor_relation: null, anchor_kind: null, anchor_board_id: null,
  anchor_preset: null, anchor_text: null, usual_time_minute: null,
  required_in_stack: 1, earns_coins: 0, coin_cap_per_day: 1,
};
const presetDefaults = { wake_minute: 420, lunch_minute: 720, dinner_minute: 1080, sleep_minute: 1380 };
type RawRow = Record<string, string | number | null>;

async function priorDatabase(version: number) {
  const db = new NodeSqlDatabase();
  await db.runAsync(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);
  for (const migration of migrations.filter((entry) => entry.version <= version)) {
    for (const sql of migration.statements) await db.runAsync(sql);
    await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)', [
      migration.version, migration.name, migrationChecksum(migration),
    ]);
  }
  await db.runAsync(`PRAGMA user_version = ${version}`);
  await db.runAsync('INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, ?, ?)', [version, 'legacy-device']);
  await db.runAsync("INSERT INTO sync_state (id, change_token, zone_created) VALUES (1, 'legacy-cursor', 1)");
  await db.runAsync(`INSERT INTO boards (id, title, symbol, accent_hex, uses_tinted_background,
    tracks_amount, amount_unit, quick_amount, tracks_time, start_of_day_minute, metrics_enabled,
    order_key, archived_at, created_at, updated_at, mutation_stamp, deleted_at) VALUES (
    'legacy-board', 'legacy count', 'star.fill', '#70A7FF', 1, 1, 'minutes', 2.5,
    1, 240, 1, 'i', NULL, 100, 200, 'legacy-stamp', NULL
  )`);
  await db.runAsync(`INSERT INTO widget_board_rows (board_id, position, title, symbol, accent_hex, strip, strip_end_date)
    VALUES ('legacy-board', 0, 'legacy count', 'star.fill', '#70A7FF', '[0,0,0,0,0,0,2]', '2026-09-08')`);
  return db;
}

describe('habit fields migration', () => {
  it.each([1, 2, 3, 4, 5])('upgrades schema %i while retaining existing rows and adding safe defaults', async (version) => {
    const db = await priorDatabase(version);
    try {
      const board = await db.getFirstAsync<RawRow>('SELECT * FROM boards');
      const widget = await db.getFirstAsync<RawRow>('SELECT * FROM widget_board_rows');
      const cursor = await db.getFirstAsync('SELECT * FROM sync_state');
      expect(await migrateDatabase(db)).toEqual({ ok: true, value: latestSchemaVersion });
      expect(await db.getFirstAsync('SELECT * FROM boards')).toEqual({ ...board, ...boardDefaults });
      expect(await db.getFirstAsync('SELECT * FROM widget_board_rows')).toEqual({ ...widget, kind: 'count' });
      expect(await db.getFirstAsync('SELECT * FROM app_settings')).toMatchObject({ ...presetDefaults, schema_revision: latestSchemaVersion, device_id: 'legacy-device' });
      expect(await db.getFirstAsync('SELECT * FROM sync_state')).toEqual(cursor);
      expect(await migrateDatabase(db)).toEqual({ ok: true, value: latestSchemaVersion });
    } finally {
      await db.closeAsync();
    }
  });

  it('creates fresh stores and omitted-kind boards with the compatibility defaults', async () => {
    const { db, deps, ids } = await createTestHarness();
    try {
      expect((await createBoard(deps, {
        commandId: ids.nextCommandId(), title: 'new count', symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: false, tracksAmount: true, tracksTime: true, startOfDayMinute: 0, metricsEnabled: true,
      })).ok).toBe(true);
      expect(await db.getFirstAsync('SELECT * FROM boards')).toMatchObject(boardDefaults);
      expect(await db.getFirstAsync('SELECT * FROM app_settings')).toMatchObject({ ...presetDefaults, schema_revision: latestSchemaVersion });
      expect(await db.getFirstAsync('SELECT * FROM widget_board_rows')).toMatchObject({ kind: 'count' });
    } finally {
      await db.closeAsync();
    }
  });

  it('keeps the released migration checksums fixed', () => {
    expect(migrations.slice(0, 5).map(migrationChecksum)).toEqual(['c459cef6', '34363ca0', 'bac085e2', 'dcbb9394', '633f8fb7']);
  });

  it('preserves the full version-5 history and local sync state', async () => {
    const db = await priorDatabase(5);
    try {
      await db.execAsync(readFileSync(path.join(__dirname, 'fixtures/v5-habit-data.sql'), 'utf8'));
      const boards = await db.getAllAsync<RawRow>('SELECT * FROM boards ORDER BY id');
      const settings = await db.getFirstAsync<RawRow>('SELECT * FROM app_settings');
      const unchanged = ['check_ins', 'board_activity_periods', 'reminders', 'reminder_schedule',
        'sync_state', 'sync_account_bindings', 'mutation_outbox', 'command_receipts', 'sync_deferred'];
      const before = await Promise.all(unchanged.map((table) => db.getAllAsync(`SELECT * FROM ${table}`)));
      expect((await migrateDatabase(db)).ok).toBe(true);
      expect(await db.getAllAsync('SELECT * FROM boards ORDER BY id')).toEqual(boards.map((board) => ({ ...board, ...boardDefaults })));
      expect(await db.getFirstAsync('SELECT * FROM app_settings')).toEqual({ ...settings, ...presetDefaults, schema_revision: latestSchemaVersion });
      for (const [index, table] of unchanged.entries()) expect(await db.getAllAsync(`SELECT * FROM ${table}`)).toEqual(before[index]);
    } finally {
      await db.closeAsync();
    }
  });

  it('rolls back every version-6 column and marker when a later statement fails', async () => {
    const db = await priorDatabase(5);
    try {
      const run = db.runAsync.bind(db);
      jest.spyOn(db, 'runAsync').mockImplementation((sql, params) => {
        if (sql.includes('ADD COLUMN wake_minute')) return Promise.reject(new Error('simulated disk failure'));
        return run(sql, params);
      });
      expect(await migrateDatabase(db)).toMatchObject({ ok: false, error: { code: 'migration' } });
      expect(await db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 5 });
      expect(await db.getAllAsync('SELECT version FROM schema_migrations')).toHaveLength(5);
      const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(boards)');
      expect(columns.map(({ name }) => name)).not.toContain('kind');
    } finally {
      await db.closeAsync();
    }
  });

  it('keeps migration 6 limited to board, settings, and widget fields', async () => {
    const db = await priorDatabase(6);
    try {
      expect(migrations.find(({ version }) => version === 6)).toBeDefined();
      const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
      for (const omitted of ['habit_actions', 'coin_ledger', 'rewards', 'miss_alerts']) {
        expect(tables.map(({ name }) => name)).not.toContain(omitted);
      }
    } finally {
      await db.closeAsync();
    }
  });

  it.each([
    ['boards', 'kind', 'weekly'], ['boards', 'anchor_relation', 'during'],
    ['boards', 'anchor_kind', 'other'], ['boards', 'anchor_preset', 'breakfast'],
    ['boards', 'required_in_stack', 0.5], ['boards', 'required_in_stack', 2],
    ['boards', 'earns_coins', -1], ['boards', 'earns_coins', 0.5],
    ['boards', 'coin_cap_per_day', 0], ['boards', 'coin_cap_per_day', 11], ['boards', 'coin_cap_per_day', 1.5],
    ['boards', 'usual_time_minute', -15], ['boards', 'usual_time_minute', 1440],
    ['boards', 'usual_time_minute', 421], ['boards', 'usual_time_minute', 420.5],
    ['app_settings', 'wake_minute', -15], ['app_settings', 'lunch_minute', 1440],
    ['app_settings', 'dinner_minute', 421], ['app_settings', 'sleep_minute', 420.5],
    ['widget_board_rows', 'kind', 'weekly'],
  ])('rejects invalid %s.%s value %s at the storage boundary', async (table, column, value) => {
    const db = await priorDatabase(5);
    try {
      await migrateDatabase(db);
      await expect(db.runAsync(`UPDATE ${table} SET ${column} = ?`, [value])).rejects.toThrow('CHECK constraint failed');
    } finally {
      await db.closeAsync();
    }
  });
});
