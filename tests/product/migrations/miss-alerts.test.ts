import { createCheckIn, deleteBoard } from '@/core/domain/commands';
import { createReward, claimReward } from '@/core/domain/reward-commands';
import { getExportSnapshot, serializeExport } from '@/core/export/serialize';
import { migrateDatabase, migrationChecksum } from '@/core/persistence/migrations';
import { latestSchemaVersion, migrations } from '@/core/persistence/schema';
import { getRewardById } from '@/core/persistence/repositories/rewards';
import { schema2SpecFor, type Schema2SyncEntityType } from '@/core/sync/schema-2-records';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHashing, NodeSqlDatabase, TestClock, TestIds, type TestHarness } from '../helpers/test-db';

const releasedChecksums = ['c459cef6', '34363ca0', 'bac085e2', 'dcbb9394', '633f8fb7',
  '0191110b', 'a901fb95', '14ff0dae', '421ece28', '5d0cab85', '507c9875'];
const meta = { databaseSchemaVersion: 12, appVersion: 'test', buildVersion: '1', locale: 'en-US' };

async function versionEleven() {
  const db = new NodeSqlDatabase();
  const clock = new TestClock(); const ids = new TestIds(); const hashing = createTestHashing();
  await db.runAsync(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  // all tables are empty during the schema-eleven evidence step; seed valid facts afterwards.
  for (const migration of migrations.filter(item => item.version <= 11)) {
    for (const sql of migration.statements) await db.runAsync(sql);
    await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?, ?, 0)',
      [migration.version, migration.name, migrationChecksum(migration)]);
  }
  await db.runAsync('PRAGMA user_version = 11');
  await db.runAsync('INSERT INTO app_settings (id, schema_revision, device_id) VALUES (1, 11, ?)', [ids.uuid()]);
  await db.runAsync("INSERT INTO sync_state (id, change_token) VALUES (1, 'retained-token')");
  const h: TestHarness = { db, clock, ids, deps: { db, clock, ids, hashing } };
  const boardId = await createBoardForTest(h, { kind: 'daily', earnsCoins: true });
  expect(await createCheckIn(h.deps, { commandId: ids.nextCommandId(), boardId, source: 'app',
    note: 'preserved private note' })).toMatchObject({ ok: true });
  const reward = await createReward(h.deps, { commandId: ids.nextCommandId(), title: 'Café break',
    costCoins: 1, symbol: 'book.fill', accentHex: '#70A7FF' });
  if (!reward.ok) throw Error('expected fixture reward');
  const savedReward = (await getRewardById(db, reward.value.rewardId))!;
  expect(await claimReward(h.deps, { commandId: ids.nextCommandId(), rewardId: reward.value.rewardId,
    expectedMutationStamp: savedReward.mutationStamp })).toMatchObject({ ok: true });
  return { ...h, boardId };
}

async function tableRows(db: NodeSqlDatabase) {
  const tables = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) rows[name] = await db.getAllAsync(`SELECT * FROM "${name}" ORDER BY rowid`);
  return rows;
}

describe('local miss-alert migration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('adds only empty local alert storage while preserving every released row and checksum', async () => {
    const h = await versionEleven();
    try {
      const before = await tableRows(h.db);
      expect(migrations.find(item => item.version === 12)?.name).toBe('local_miss_alerts');
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toEqual({ ok: true, value: 12 });
      expect(latestSchemaVersion).toBe(12);
      expect(migrations.slice(0, 11).map(migrationChecksum)).toEqual(releasedChecksums);
      expect(migrations[10].dataStep).toEqual({ name: 'legacy_check_evidence', version: 1 });
      const after = await tableRows(h.db);
      expect(Object.keys(after).filter(name => !(name in before))).toEqual(['miss_alerts']);
      for (const [table, rows] of Object.entries(before)) {
        if (table === 'schema_migrations') expect(after[table].slice(0, 11)).toEqual(rows);
        else if (table === 'app_settings') expect(after[table]).toEqual(rows.map(row => ({ ...row as object, schema_revision: 12 })));
        else expect(after[table]).toEqual(rows);
      }
      expect(after.miss_alerts).toEqual([]);
      expect(await h.db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 12 });
      expect((await h.db.getAllAsync<{ name: string }>('PRAGMA table_info(miss_alerts)')).map(row => row.name))
        .toEqual(['board_id', 'second_missed_date', 'native_identifier', 'status']);
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toEqual({ ok: true, value: 12 });
      expect(await tableRows(h.db)).toEqual(after);
    } finally { await h.db.closeAsync(); }
  });

  it.each(['CREATE TABLE miss_alerts', 'CREATE INDEX idx_miss_alerts_status',
    'UPDATE app_settings SET schema_revision = 12', 'INSERT INTO schema_migrations',
    'PRAGMA user_version = 12'])('rolls back the whole new migration at %s and can retry', async failure => {
    const h = await versionEleven();
    try {
      const before = await tableRows(h.db);
      const run = h.db.runAsync.bind(h.db);
      const spy = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => {
        if (sql.includes(failure)) return Promise.reject(new Error('simulated disk failure'));
        return run(sql, params);
      });
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toMatchObject({ ok: false, error: { code: 'migration' } });
      expect(await h.db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 11 });
      expect(await tableRows(h.db)).toEqual(before);
      expect(await h.db.getAllAsync("SELECT name FROM sqlite_master WHERE name LIKE '%miss_alerts%'")).toEqual([]);
      spy.mockRestore();
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toEqual({ ok: true, value: 12 });
      expect(await h.db.getAllAsync('SELECT * FROM miss_alerts')).toEqual([]);
    } finally { await h.db.closeAsync(); }
  });

  it('enforces pair/status identity and retains local deduplication after a board tombstone', async () => {
    const h = await versionEleven();
    try {
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toEqual({ ok: true, value: 12 });
      const insert = (date: string, status: string, nativeId: string | null) => h.db.runAsync(
        'INSERT INTO miss_alerts (board_id, second_missed_date, native_identifier, status) VALUES (?, ?, ?, ?)',
        [h.boardId, date, nativeId, status]);
      await insert('2026-08-20', 'pending', null);
      await insert('2026-08-21', 'pending', 'reserved-id');
      await insert('2026-08-22', 'scheduled', 'accepted-id');
      await insert('2026-08-23', 'denied', null);
      await insert('2026-08-24', 'error', null);
      await insert('2026-08-25', 'error', 'uncertain-id');
      await expect(insert('2026-08-20', 'error', null)).rejects.toThrow('UNIQUE constraint');
      for (const [status, nativeId] of [['invalid', null], ['scheduled', null], ['denied', 'invalid-id']] as const)
        await expect(insert('2026-08-26', status, nativeId)).rejects.toThrow('CHECK constraint');
      const before = await h.db.getAllAsync('SELECT * FROM miss_alerts ORDER BY second_missed_date');
      const plan = await h.db.getAllAsync<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM miss_alerts WHERE status = 'pending'");
      expect(plan.some(row => row.detail.includes('idx_miss_alerts_status'))).toBe(true);
      expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: h.boardId })).toMatchObject({ ok: true });
      expect(await h.db.getAllAsync('SELECT * FROM miss_alerts ORDER BY second_missed_date')).toEqual(before);
      expect(await h.db.getAllAsync('PRAGMA foreign_key_list(miss_alerts)')).toEqual([
        expect.objectContaining({ table: 'boards', from: 'board_id', to: 'id', on_delete: 'NO ACTION' }),
      ]);
      await expect(h.db.runAsync('INSERT INTO miss_alerts VALUES (?, ?, NULL, ?)',
        [h.ids.uuid(), '2026-08-26', 'pending'])).rejects.toThrow('FOREIGN KEY constraint');
    } finally { await h.db.closeAsync(); }
  });

  it('excludes local alert rows and identifiers from backup and synchronized state', async () => {
    const h = await versionEleven();
    try {
      expect(await migrateDatabase(h.db, { hashing: h.deps.hashing })).toEqual({ ok: true, value: 12 });
      const exported = await getExportSnapshot(h.deps, meta);
      const before = await tableRows(h.db);
      await h.db.runAsync('INSERT INTO miss_alerts VALUES (?, ?, ?, ?)',
        [h.boardId, '2026-08-28', 'LOCAL_MISS_IDENTIFIER_SENTINEL', 'scheduled']);
      const afterExport = await getExportSnapshot(h.deps, meta);
      expect(afterExport).toEqual(exported);
      if (!afterExport.ok) throw Error('expected export');
      expect(serializeExport(afterExport.value)).not.toMatch(/miss_alert|LOCAL_MISS_IDENTIFIER_SENTINEL/);
      const after = await tableRows(h.db);
      for (const table of Object.keys(before).filter(name => name !== 'miss_alerts')) expect(after[table]).toEqual(before[table]);
      const wireTypes: Schema2SyncEntityType[] = ['board', 'check_in', 'reminder', 'activity_period', 'settings', 'reward', 'habit_action', 'ledger_entry'];
      expect(wireTypes.map(type => schema2SpecFor(type).table)).not.toContain('miss_alerts');
    } finally { await h.db.closeAsync(); }
  });
});
