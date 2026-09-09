import fixture from '@/core/automations/fixtures/check-coins.json';
import { createBoard, setICloudSyncEnabled } from '@/core/domain/commands';
import { CoinContractError } from '@/core/domain/coin-policy';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { runSync } from '@/core/sync/engine';
import { IMMUTABLE_FIELD_MAP } from '@/core/sync/immutable-records';
import { toSchema2SyncRecord } from '@/core/sync/schema-2-records';
import type { WireSyncRecord, SyncTransport } from '@/core/sync/transport';
import { createTestHarness, type TestHarness } from '../helpers/test-db';
import { createBoardForTest } from '../helpers/product-fixtures';

const source = fixture.cases[0].actions[0] as HabitAction;
const award = fixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
function fact(type: keyof typeof IMMUTABLE_FIELD_MAP, value: HabitAction | CoinLedgerRow) {
  const domain = value as unknown as Record<string, unknown>;
  return toSchema2SyncRecord(type, value.id, value.mutationStamp,
    Object.fromEntries(Object.entries(IMMUTABLE_FIELD_MAP[type]).map(([wire, key]) => [wire, domain[key]])));
}
function checkPayload() {
  return toSchema2SyncRecord('check_in', source.checkInId!, source.mutationStamp, {
    id: source.checkInId, board_id: source.boardId, logical_date: source.logicalDate, occurred_at_utc: null,
    time_zone_id: null, offset_minutes: null, amount: null, note: 'private raw payload', source: 'app',
    idempotency_key: source.checkInId, created_at: source.createdAt, updated_at: source.createdAt, deleted_at: null,
  });
}
function transport(records: WireSyncRecord[], token = 'page') : SyncTransport<WireSyncRecord> {
  return { ensureZone: async () => {}, upload: async () => {}, fetchChanges: async () => ({ records, nextToken: token, more: false }) };
}
function gate() {
  let resolve!: () => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger',
  'remote_fact_inbox', 'app_settings', 'mutation_outbox', 'command_receipts', 'widget_board_rows'];
const snapshot = (tx: SqlExecutor) => Promise.all(tables.map(table => tx.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
let h: TestHarness;
beforeEach(async () => {
  h = await createTestHarness();
  await createBoardForTest({ ...h, deps: { ...h.deps, ids: { uuid: () => source.boardId } } }, { earnsCoins: true });
  await setICloudSyncEnabled(h.deps, { commandId: h.ids.nextCommandId(), enabled: true });
  expect(await runSync({ ...h.deps, transport: transport([], 'ready'), random: () => 0 })).toMatchObject({ ok: true, value: { status: 'up_to_date' } });
});
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

describe('schema 2 page atomicity', () => {
  it.each(['INSERT INTO habit_actions', 'INSERT INTO coin_ledger', 'UPDATE check_ins SET state_suppressed',
    'UPDATE app_settings SET hlc_wall_time', 'INSERT INTO widget_board_rows', 'INSERT INTO sync_state'])(
    'rolls back after the actual %s write and safely retries the whole page', async statement => {
      const before = await snapshot(h.db);
      const wrapped = Object.create(h.db) as SqlDatabase;
      let hit = false;
      wrapped.withExclusiveTransactionAsync = work => h.db.withExclusiveTransactionAsync(tx => {
        const failing = Object.create(tx) as SqlExecutor;
        failing.runAsync = async (sql, params) => {
          const result = await tx.runAsync(sql, params);
          if (!hit && sql.includes(statement)) { hit = true; throw new Error('after actual write'); }
          return result;
        };
        return work(failing);
      });
      const records = [checkPayload(), fact('habit_action', source)];
      expect(await runSync({ ...h.deps, db: wrapped, transport: transport(records), random: () => 0 }))
        .toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0, localChanged: false } });
      expect(hit).toBe(true);
      expect(await snapshot(h.db)).toEqual(before);
      expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'ready' });
      expect(await runSync({ ...h.deps, transport: transport(records), random: () => 0 })).toMatchObject({ ok: true, value: { applied: 2 } });
      expect(await h.db.getAllAsync('SELECT id,delta FROM coin_ledger')).toEqual([{ id: award.id, delta: 1 }]);
      expect(await h.db.getFirstAsync('SELECT state_suppressed,note FROM check_ins')).toEqual({ state_suppressed: 0, note: 'private raw payload' });
    });

  it.each([false, true])('cancels an acquired page during a held provider that later rejects=%s', async rejects => {
    const before = await snapshot(h.db); const beforeSync = await h.db.getFirstAsync('SELECT * FROM sync_state');
    const entered = gate(); const release = gate(); let running = true;
    const hashing = { ...h.deps.hashing, sha256: async (bytes: Uint8Array) => {
      entered.resolve(); await release.promise; return h.deps.hashing.sha256(bytes);
    } };
    const run = runSync({ ...h.deps, hashing, transport: transport([checkPayload(), fact('habit_action', source)]), random: () => 0,
      shouldContinue: () => running });
    await entered.promise; running = false;
    if (rejects) release.reject(new CoinContractError('size')); else release.resolve();
    expect(await run).toMatchObject({ ok: true, value: { status: 'idle', applied: 0, localChanged: false, retryAfterMs: null } });
    expect(await snapshot(h.db)).toEqual(before);
    expect(await h.db.getFirstAsync('SELECT * FROM sync_state')).toEqual(beforeSync);
  });

  it('does not quarantine provider size failures or advance a token after mutable writes', async () => {
    const before = await snapshot(h.db);
    const hashing = { ...h.deps.hashing, sha256: async () => { throw new CoinContractError('size'); } };
    expect(await runSync({ ...h.deps, hashing, transport: transport([checkPayload(), fact('habit_action', source)]), random: () => 0 }))
      .toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0 } });
    expect(await snapshot(h.db)).toEqual(before);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'ready' });
  });

  it('observes only accepted immutable stamps and carries an accepted max counter into the next public mutation', async () => {
    const pending = fact('ledger_entry', { ...award, mutationStamp: '99999999999999-zzzzz-pending' });
    const invalid = { ...fact('habit_action', source), mutationStamp: '99999999999999-zzzzz-invalid', deleted: true };
    const before = await h.db.getFirstAsync('SELECT hlc_wall_time,hlc_counter FROM app_settings');
    expect(await runSync({ ...h.deps, transport: transport([pending, invalid]), random: () => 0 }))
      .toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0, localChanged: true } });
    expect(await h.db.getFirstAsync('SELECT hlc_wall_time,hlc_counter FROM app_settings')).toEqual(before);
    const accepted = { ...source, mutationStamp: '01788825600000-zzzzz-accepted' };
    expect(await runSync({ ...h.deps, transport: transport([fact('habit_action', accepted)], 'next'), random: () => 0 })).toMatchObject({ ok: true });
    expect(await h.db.getFirstAsync('SELECT hlc_wall_time,hlc_counter FROM app_settings')).toEqual({ hlc_wall_time: 1788825600000, hlc_counter: 60466175 });
    const created = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), title: 'after observed evidence', symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
    expect(created).toMatchObject({ ok: true });
    expect(await h.db.getFirstAsync('SELECT hlc_wall_time,hlc_counter FROM app_settings')).toEqual({ hlc_wall_time: 1788825600001, hlc_counter: 0 });
  });

  it('captures the entire fetched page before the first hash can mutate borrowed input', async () => {
    const records = [checkPayload(), fact('habit_action', source)];
    const page = { records, nextToken: 'captured', more: false };
    let changed = false;
    const hashing = { ...h.deps.hashing, sha256: async (bytes: Uint8Array) => {
      if (!changed) {
        changed = true; records[1].fields.id = 'not-an-id'; records[1].fields.policy_json = 'x'.repeat(196_609);
        records[0].fields.note = 'changed'; records.length = 0; page.nextToken = 'changed';
      }
      return h.deps.hashing.sha256(bytes);
    } };
    expect(await runSync({ ...h.deps, hashing, transport: { ...transport([]), fetchChanges: async () => page }, random: () => 0 }))
      .toMatchObject({ ok: true, value: { applied: 2, status: 'up_to_date' } });
    expect(changed).toBe(true);
    expect(await h.db.getFirstAsync('SELECT id,delta FROM coin_ledger')).toEqual({ id: award.id, delta: 1 });
    expect(await h.db.getFirstAsync('SELECT note FROM check_ins')).toEqual({ note: 'private raw payload' });
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'captured' });
  });

  it.each(['habit_action', 'ledger_entry'])('does not acknowledge a dangling accepted %s outbox identity', async type => {
    await h.db.runAsync('INSERT INTO mutation_outbox (entity_type,entity_id,mutation_stamp,created_at) VALUES (?,?,?,?)',
      [type, '00000000-0000-4000-8000-000000009900', source.mutationStamp, 1]);
    const before = await snapshot(h.db); let uploads = 0;
    expect(await runSync({ ...h.deps, transport: { ...transport([]), upload: async () => { uploads++; } }, random: () => 0 }))
      .toMatchObject({ ok: true, value: { status: 'needs_attention', uploaded: 0 } });
    expect(uploads).toBe(0); expect(await snapshot(h.db)).toEqual(before);
  });

  it('refuses a queued settings payload without an actual source stamp', async () => {
    await h.db.runAsync("INSERT INTO mutation_outbox (entity_type,entity_id,mutation_stamp,created_at) VALUES ('settings','app-settings',?,1)", [source.mutationStamp]);
    const before = await snapshot(h.db);
    expect(await runSync({ ...h.deps, transport: transport([]), random: () => 0 }))
      .toMatchObject({ ok: true, value: { status: 'needs_attention', uploaded: 0 } });
    expect(await snapshot(h.db)).toEqual(before);
  });

  it('fails a fetched page if settings disappeared after preflight instead of publishing incoming data', async () => {
    const remote = { ...transport([]), fetchChanges: async () => {
      await h.db.runAsync('DELETE FROM app_settings');
      return { records: [fact('habit_action', source)], nextToken: 'bad', more: false };
    } };
    expect(await runSync({ ...h.deps, transport: remote, random: () => 0 })).toMatchObject({ ok: true, value: { status: 'needs_attention', applied: 0 } });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT change_token FROM sync_state')).toEqual({ change_token: 'ready' });
  });
});
