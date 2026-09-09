import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveBoard, createCheckIn, deleteBoard, updateBoard, removeCheckIn } from '@/core/domain/commands';
import { setAnchorPresetMinute } from '@/core/domain/anchor-settings-commands';
import { createReward, claimReward, archiveReward, deleteReward } from '@/core/domain/reward-commands';
import { canonicalHabitAction } from '@/core/domain/habit-actions';
import { canonicalCoinLedger } from '@/core/domain/coin-ledger';
import { getExportSnapshot, serializeExport } from '@/core/export/serialize';
import { parseOwnExport } from '@/core/export/import-parsers';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { getCheckInById } from '@/core/persistence/repositories/check-ins';
import { getRewardById } from '@/core/persistence/repositories/rewards';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';
import type { LogicalDate } from '@/core/domain/ids';
import { createBoardForTest } from '../helpers/product-fixtures';
import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const meta = { databaseSchemaVersion: 11, appVersion: 'test', buildVersion: '1', locale: 'en-US' };
const date = '2026-08-30' as LogicalDate;
const snapshot = (h: TestHarness) => Promise.all(['boards', 'check_ins', 'board_activity_periods', 'habit_actions',
  'coin_ledger', 'rewards', 'app_settings', 'mutation_outbox', 'command_receipts', 'remote_fact_inbox']
  .map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));

describe('version two offline export', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  it('exports all surviving converted Count history, anchors, presets and accepted immutable bytes without writes', async () => {
    const root = await createBoardForTest(h, { kind: 'count', earnsCoins: true, coinCapPerDay: 10,
      tracksAmount: true, amountUnit: 'pages', quickAmount: 3, tracksTime: true,
      anchor: { kind: 'preset', relation: 'after', preset: 'wake' }, usualTimeMinute: 0 });
    const child = await createBoardForTest(h, { anchor: { kind: 'board', relation: 'before', boardId: root }, requiredInStack: false });
    for (const note of ['one', 'two']) expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId: root, source: 'shortcut', note })).toMatchObject({ ok: true });
    const saved = (await getBoardById(h.db, root))!;
    expect(await updateBoard(h.deps, { ...saved, commandId: h.ids.nextCommandId(), boardId: root,
      expectedMutationStamp: saved.mutationStamp, kind: 'daily', tracksAmount: false, tracksTime: false })).toMatchObject({ ok: true });
    expect(await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: child })).toMatchObject({ ok: true });
    expect(await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'sleep', minute: 1425 })).toMatchObject({ ok: true });
    const originalActions = await listHabitActions(h.db, root, date);
    const originalLedger = await listLedgerEntriesForScope(h.db, `check:${root}:${date}`);
    const before = await snapshot(h); const exported = await getExportSnapshot(h.deps, meta);
    expect(exported.ok).toBe(true); if (!exported.ok) throw Error('expected export');
    expect(exported.value.exportVersion).toBe(2);
    expect(exported.value.boards.find(row => row.id === root)).toMatchObject({ kind: 'daily', tracksAmount: false,
      tracksTime: false, anchorPreset: 'wake', usualTimeMinute: 0, coinCapPerDay: 10 });
    expect(exported.value.boards.find(row => row.id === child)).toMatchObject({ anchorBoardId: root, requiredInStack: false, archivedAtUtc: h.clock.utcMs });
    expect(exported.value.checkIns).toHaveLength(2);
    expect(exported.value.checkIns.map(row => [row.note, row.amount, row.source])).toEqual([['one', 3, 'shortcut'], ['two', 3, 'shortcut']]);
    expect(exported.value.checkIns.every(row => row.occurredAtUtc !== null)).toBe(true);
    expect(exported.value.settings.sleepMinute).toBe(1425);
    expect(exported.value.habitActions.filter(row => row.boardId === root).map(canonicalHabitAction).sort()).toEqual(originalActions.map(canonicalHabitAction).sort());
    expect(exported.value.coinLedger.filter(row => row.scopeKey === `check:${root}:${date}`).map(canonicalCoinLedger).sort()).toEqual(originalLedger.map(canonicalCoinLedger).sort());
    expect(parseOwnExport(serializeExport(exported.value))).toMatchObject({ ok: true, value: { exportVersion: 2 } });
    expect(await snapshot(h)).toEqual(before);
  });

  it('omits cleared raw notes and deleted parents while retaining claim and action history', async () => {
    const boardId = await createBoardForTest(h, { kind: 'count', earnsCoins: true, coinCapPerDay: 10 });
    const check = await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app', note: 'secret cleared note' });
    if (!check.ok) throw Error('expected check');
    const reward = await createReward(h.deps, { commandId: h.ids.nextCommandId(), title: 'Café', costCoins: 1, symbol: 'book.fill', accentHex: '#F2F2F7' });
    if (!reward.ok) throw Error('expected reward');
    const row = (await getRewardById(h.db, reward.value.rewardId))!;
    expect(await claimReward(h.deps, { commandId: h.ids.nextCommandId(), rewardId: row.id, expectedMutationStamp: row.mutationStamp })).toMatchObject({ ok: true });
    const checkRow = (await getCheckInById(h.db, check.value.checkInId))!;
    expect(await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: checkRow.id, expectedMutationStamp: checkRow.mutationStamp })).toMatchObject({ ok: true });
    // a raw payload edit cannot undo accepted removal evidence.
    await h.db.runAsync('UPDATE check_ins SET deleted_at = NULL, note = ? WHERE id = ?', ['secret raw resurrection', checkRow.id]);
    const first = await getExportSnapshot(h.deps, meta); if (!first.ok) throw Error('expected export');
    expect(first.value.checkIns).toEqual([]);
    expect(serializeExport(first.value)).not.toContain('secret');
    h.clock.advanceDays(1);
    expect(await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId })).toMatchObject({ ok: true });
    expect(await deleteReward(h.deps, { commandId: h.ids.nextCommandId(), rewardId: row.id })).toMatchObject({ ok: true });
    const exported = await getExportSnapshot(h.deps, meta); if (!exported.ok) throw Error('expected export');
    expect(exported.value.boards).toEqual([]); expect(exported.value.rewards).toEqual([]);
    expect(exported.value.habitActions.some(action => action.checkInId === checkRow.id)).toBe(true);
    expect(exported.value.coinLedger.find(entry => entry.kind === 'claim')).toMatchObject({ rewardId: row.id, rewardTitleSnapshot: 'Café', delta: -1 });
    for (const action of exported.value.habitActions) expect(Object.keys(action).sort()).toEqual(['id', 'commandId', 'boardId', 'logicalDate', 'checkInId', 'kind', 'createdAt', 'mutationStamp', 'policyJson'].sort());
  });

  it('preserves active and archived reward metadata while excluding local state', async () => {
    for (const title of ['active', 'archived']) {
      const created = await createReward(h.deps, { commandId: h.ids.nextCommandId(), title, costCoins: 100000, symbol: 'book.fill', accentHex: '#000000' });
      if (!created.ok) throw Error('expected reward');
      if (title === 'archived') expect(await archiveReward(h.deps, { commandId: h.ids.nextCommandId(), rewardId: created.value.rewardId })).toMatchObject({ ok: true });
    }
    const result = await getExportSnapshot(h.deps, meta); if (!result.ok) throw Error('expected export');
    expect(result.value.rewards.map(row => row.title)).toEqual(['active', 'archived']);
    for (const row of result.value.rewards) expect(Object.keys(row).sort()).toEqual(['id', 'title', 'costCoins', 'symbol', 'accentHex', 'orderKey', 'createdAtUtc', 'archivedAtUtc'].sort());
    expect(Object.keys(result.value.settings).sort()).toEqual(['metricsEducationDismissed', 'wakeMinute', 'lunchMinute', 'dinnerMinute', 'sleepMinute'].sort());
  });
  it('keeps accepted facts and mutable rows in the same real WAL snapshot', async () => {
    const boardId = await createBoardForTest(h, { kind: 'count', earnsCoins: true });
    const directory = mkdtempSync(join(tmpdir(), 'habit-export-snapshot-'));
    const path = join(directory, 'data.sqlite');
    await h.db.execAsync(`VACUUM INTO '${path}'`);
    const reader = new NodeSqlDatabase(path); const writer = new NodeSqlDatabase(path);
    try {
      await writer.execAsync('PRAGMA journal_mode = WAL');
      const inputMeta = { ...meta };
      const read = reader.getAllAsync.bind(reader); let changed = false;
      jest.spyOn(reader, 'getAllAsync').mockImplementation(async (sql, params) => {
        const rows = await read(sql, params);
        if (!changed && sql.includes('FROM boards')) {
          changed = true; inputMeta.appVersion = 'changed while reading';
          expect(await createCheckIn({ ...h.deps, db: writer }, { commandId: h.ids.nextCommandId(), boardId, source: 'app' })).toMatchObject({ ok: true });
          expect(await setAnchorPresetMinute({ ...h.deps, db: writer }, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 0 })).toMatchObject({ ok: true });
        }
        return rows;
      });
      const exported = await getExportSnapshot({ ...h.deps, db: reader }, inputMeta);
      if (!exported.ok) throw Error('expected export');
      expect(changed).toBe(true); expect(exported.value.appVersion).toBe('test');
      expect(exported.value.checkIns).toEqual([]); expect(exported.value.coinLedger).toEqual([]);
      expect(exported.value.habitActions).toEqual([]); expect(exported.value.settings.wakeMinute).toBe(420);
      expect(await writer.getFirstAsync('SELECT COUNT(*) AS n FROM check_ins')).toEqual({ n: 1 });
      expect(await writer.getFirstAsync('SELECT COUNT(*) AS n FROM coin_ledger')).toEqual({ n: 1 });
      expect(await writer.getFirstAsync('SELECT wake_minute AS wake FROM app_settings')).toEqual({ wake: 0 });
    } finally { await reader.closeAsync(); await writer.closeAsync(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['action', 'ledger'])('fails safely for corrupt retained %s storage instead of exporting a partial backup', async kind => {
    const boardId = await createBoardForTest(h, { kind: 'count', earnsCoins: true });
    expect(await createCheckIn(h.deps, { commandId: h.ids.nextCommandId(), boardId, source: 'app' })).toMatchObject({ ok: true });
    // a separate malformed raw row represents storage corruption; accepted originals are untouched.
    if (kind === 'action') {
      await h.db.runAsync(`INSERT INTO habit_actions
        SELECT ?, command_id, board_id, logical_date, check_in_id, kind, created_at, mutation_stamp, ?
        FROM habit_actions LIMIT 1`, [h.ids.uuid(), 'private corrupt evidence']);
    } else {
      await h.db.runAsync(`INSERT INTO coin_ledger
        SELECT ?, kind, delta, board_id, check_in_id, run_key, reward_id, reward_title_snapshot, reverses_id,
        scope_key, source_action_id, reconciliation_key, adjusts_id, provenance_json, logical_date,
        created_at, ?, deleted_at FROM coin_ledger LIMIT 1`, ['ffffffff-ffff-5fff-8fff-ffffffffffff', 'private invalid stamp']);
    }
    const before = await snapshot(h);
    expect(await getExportSnapshot(h.deps, meta)).toEqual({ ok: false, error: { code: 'database',
      message: 'The export could not be generated. Try again.', field: undefined, retryable: true } });
    expect(await snapshot(h)).toEqual(before);
  });

});
