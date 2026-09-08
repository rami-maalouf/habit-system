import { setAnchorPresetMinute } from '@/core/domain/commands';
import type { AnchorPreset } from '@/core/domain/entities';
import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';
import { getReceipt, getSettings } from '@/core/persistence/repositories/support';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

async function snapshot(db: SqlExecutor, includeReceipts = true) {
  const tables = [
    'app_settings', 'mutation_outbox', 'boards', 'check_ins',
    'habit_actions', 'reminders', 'widget_board_rows',
    ...(includeReceipts ? ['command_receipts'] : []),
  ];
  const rows = await Promise.all(tables.map((table) => db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]]));
}

function failingAt(db: SqlDatabase, statement: string): SqlDatabase {
  const wrapped = Object.create(db) as SqlDatabase;
  wrapped.withExclusiveTransactionAsync = (work) => db.withExclusiveTransactionAsync((tx) => {
    const failing = Object.create(tx) as SqlExecutor;
    failing.runAsync = (sql, params) => {
      if (sql.includes(statement)) throw new Error('injected anchor storage failure');
      return tx.runAsync(sql, params);
    };
    return work(failing);
  });
  return wrapped;
}

describe('anchor preset settings commands', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it.each([
    ['wake', 'wakeMinute', 0],
    ['lunch', 'lunchMinute', 735],
    ['dinner', 'dinnerMinute', 1095],
    ['sleep', 'sleepMinute', 1425],
  ] as const)('changes only %s and writes one matching settings stamp and outbox row', async (preset, field, minute) => {
    const before = await getSettings(h.db);
    expect(before).toMatchObject({ wakeMinute: 420, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1380 });
    const commandId = h.ids.nextCommandId();
    const result = await setAnchorPresetMinute(h.deps, { commandId, preset, minute });
    expect(result).toEqual({ ok: true, value: { preset, minute } });
    expect(await getSettings(h.db)).toEqual({ ...before, [field]: minute, hlcWallTime: h.clock.utcMs, hlcCounter: 0 });
    const stamped = await h.db.getFirstAsync<{ settings_mutation_stamp: string }>('SELECT settings_mutation_stamp FROM app_settings');
    expect(stamped?.settings_mutation_stamp).toEqual(expect.any(String));
    expect(await h.db.getAllAsync('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox')).toEqual([{
      entity_type: 'settings', entity_id: 'app-settings', mutation_stamp: stamped!.settings_mutation_stamp, created_at: h.clock.utcMs,
    }]);
    expect(JSON.parse((await getReceipt(h.db, commandId))!)).toEqual(result);
  });

  it('records an unchanged selection receipt without advancing settings or mutation evidence', async () => {
    const before = await snapshot(h.db, false);
    const commandId = h.ids.nextCommandId();
    expect(await setAnchorPresetMinute(h.deps, { commandId, preset: 'wake', minute: 420 }))
      .toEqual({ ok: true, value: { preset: 'wake', minute: 420 } });
    expect(await snapshot(h.db, false)).toEqual(before);
    expect(await h.db.getAllAsync('SELECT command_id FROM command_receipts')).toEqual([{ command_id: commandId }]);
  });

  const invalidPresets: unknown[] = ['breakfast', '', 'constructor', '__proto__', null, undefined, ['wake']];
  it.each(invalidPresets)('rejects an unsupported preset %p before settings or outbox writes', async (preset) => {
    const before = await snapshot(h.db, false);
    const commandId = h.ids.nextCommandId();
    const result = await setAnchorPresetMinute(h.deps, { commandId, preset: preset as AnchorPreset, minute: 420 });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation', field: 'preset' } });
    expect(await snapshot(h.db, false)).toEqual(before);
    expect(JSON.parse((await getReceipt(h.db, commandId))!)).toEqual(result);
  });

  const invalidMinutes: unknown[] = [-1, 1440, 1439, 421, 420.5, NaN, Infinity, -Infinity, '420', null];
  it.each(invalidMinutes)('rejects a non-quarter-hour minute %p before settings or outbox writes', async (minute) => {
    const before = await snapshot(h.db, false);
    const result = await setAnchorPresetMinute(h.deps, {
      commandId: h.ids.nextCommandId(), preset: 'wake', minute: minute as number,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation', field: 'minute' } });
    expect(await snapshot(h.db, false)).toEqual(before);
  });

  it('replays the acknowledged selection before validating changed retry input', async () => {
    const commandId = h.ids.nextCommandId();
    const first = await setAnchorPresetMinute(h.deps, { commandId, preset: 'wake', minute: 435 });
    expect(first.ok).toBe(true);
    expect((await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'sleep', minute: 1350 })).ok).toBe(true);
    const committed = await snapshot(h.db);
    h.clock.advanceDays(1);
    expect(await setAnchorPresetMinute(h.deps, { commandId, preset: 'invalid' as AnchorPreset, minute: Infinity })).toEqual(first);
    expect(await snapshot(h.db)).toEqual(committed);
  });

  it('replays a rejected selection until a corrected edit supplies a new command id', async () => {
    const commandId = h.ids.nextCommandId();
    const rejected = await setAnchorPresetMinute(h.deps, { commandId, preset: 'wake', minute: 421 });
    const committed = await snapshot(h.db);
    expect(await setAnchorPresetMinute(h.deps, { commandId, preset: 'wake', minute: 435 })).toEqual(rejected);
    expect(await snapshot(h.db)).toEqual(committed);
    expect(await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 435 }))
      .toEqual({ ok: true, value: { preset: 'wake', minute: 435 } });
  });

  it('merges separately queued presets from their transaction settings without losing either edit', async () => {
    const results = await Promise.all([
      setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 0 }),
      setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'sleep', minute: 1425 }),
      setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'lunch', minute: 735 }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await getSettings(h.db)).toMatchObject({ wakeMinute: 0, lunchMinute: 735, dinnerMinute: 1080, sleepMinute: 1425, hlcCounter: 2 });
    const outbox = await h.db.getAllAsync<{ mutation_stamp: string }>('SELECT mutation_stamp FROM mutation_outbox ORDER BY id');
    expect(outbox).toHaveLength(3);
    expect(new Set(outbox.map((row) => row.mutation_stamp)).size).toBe(3);
    expect(await h.db.getFirstAsync('SELECT settings_mutation_stamp FROM app_settings')).toEqual({ settings_mutation_stamp: outbox[2].mutation_stamp });
  });

  it.each([
    'UPDATE app_settings SET wake_minute',
    'INSERT INTO mutation_outbox',
    'INSERT INTO command_receipts',
  ])('rolls back settings, stamp, outbox and receipt when %s fails, then retries once', async (statement) => {
    const before = await snapshot(h.db);
    const input = { commandId: h.ids.nextCommandId(), preset: 'wake' as const, minute: 450 };
    const result = await setAnchorPresetMinute({ ...h.deps, db: failingAt(h.db, statement) }, input);
    expect(result).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await snapshot(h.db)).toEqual(before);
    const retried = await setAnchorPresetMinute(h.deps, input);
    expect(retried).toEqual({ ok: true, value: { preset: 'wake', minute: 450 } });
    const committed = await snapshot(h.db);
    expect(await setAnchorPresetMinute(h.deps, input)).toEqual(retried);
    expect(await snapshot(h.db)).toEqual(committed);
    expect(await h.db.getAllAsync('SELECT id FROM mutation_outbox')).toHaveLength(1);
  });
});
