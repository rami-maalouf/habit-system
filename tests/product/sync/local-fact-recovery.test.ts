import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { Board } from '@/core/domain/entities';
import { prepareRemoteFacts } from '@/core/domain/remote-fact-validation';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { applyRemoteFactInboxChanges } from '@/core/persistence/repositories/remote-fact-inbox';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { insertBoard } from '@/core/persistence/repositories/boards';
import { insertCheckIn, dailyCounts } from '@/core/persistence/repositories/check-ins';
import { rebuildWidgetRows, readWidgetRows } from '@/core/persistence/projections/widget-rows';
import { runSync } from '@/core/sync/engine';
import { recoverLocalFacts } from '@/core/sync/local-fact-recovery';
import { SyncCoordinator } from '@/features/product-store/sync-coordinator';

import { FakeSyncTransport } from '../helpers/fake-transport';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;

async function seed(h: TestHarness, intent = false) {
  const [prepared] = await prepareRemoteFacts([{ factType: 'habit_action', factId: source.id,
    value: source, enqueueOnAdmission: intent }], h.deps.hashing);
  await h.db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx, {
    upserts: [{ prepared, disposition: { state: 'pending', reason: 'dependency' } }], removals: [],
  }, 100));
}

describe('local immutable recovery while iCloud is off', () => {
  let h: TestHarness;
  let transport: FakeSyncTransport;
  beforeEach(async () => { h = await createTestHarness(); transport = new FakeSyncTransport(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
  const run = () => runSync({ ...h.deps, transport, random: () => 0 });
  const syncState = () => h.db.getAllAsync('SELECT * FROM sync_state');
  const snapshot = () => Promise.all(['habit_actions', 'coin_ledger', 'remote_fact_inbox',
    'mutation_outbox', 'app_settings', 'widget_board_rows', 'sync_state', 'command_receipts']
    .map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));

  it.each([false, true])('promotes staged sources and settles once with retained restore intent %s and no network calls', async intent => {
    await seed(h, intent);
    const beforeState = await syncState();
    const beforeReceipts = await h.db.getAllAsync('SELECT * FROM command_receipts');
    const beforeBaselines = await h.db.getAllAsync("SELECT * FROM habit_actions WHERE kind = 'baseline'");
    const fetched = jest.spyOn(transport, 'fetchChanges');
    expect(await run()).toMatchObject({ ok: true, value: { status: 'idle', uploaded: 0,
      applied: 0, localChanged: true, retryAfterMs: null } });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await h.db.getAllAsync('SELECT entity_type, entity_id FROM mutation_outbox ORDER BY id'))
      .toEqual(intent ? [{ entity_type: 'habit_action', entity_id: source.id },
        { entity_type: 'ledger_entry', entity_id: award.id }] : [{ entity_type: 'ledger_entry', entity_id: award.id }]);
    expect(await syncState()).toEqual(beforeState);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(beforeReceipts);
    expect(await h.db.getAllAsync("SELECT * FROM habit_actions WHERE kind = 'baseline'")).toEqual(beforeBaselines);
    expect(transport.ensureZoneCalls).toBe(0);
    expect(transport.uploads).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    const writes = jest.spyOn(h.db, 'runAsync');
    expect(await run()).toMatchObject({ ok: true, value: { status: 'idle', localChanged: false } });
    expect(writes).not.toHaveBeenCalled();
  });

  it('refreshes app queries after disabled recovery without publishing a network syncing state', async () => {
    await seed(h);
    const publish = jest.fn();
    const refresh = jest.fn();
    const coordinator = new SyncCoordinator(h.deps, transport, publish, refresh);
    try {
      await coordinator.request();
      expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls.every(([state]) => state.status === 'idle' && state.busy === false)).toBe(true);
      await coordinator.request();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(transport.ensureZoneCalls).toBe(0);
    } finally { coordinator.dispose(); }
  });

  it('retains a later local clock while admitting older evidence', async () => {
    await seed(h);
    await h.db.runAsync('UPDATE app_settings SET hlc_wall_time = 99999999999999, hlc_counter = 10');
    expect(await run()).toMatchObject({ ok: true, value: { localChanged: true } });
    expect(await h.db.getFirstAsync('SELECT hlc_wall_time, hlc_counter FROM app_settings'))
      .toEqual({ hlc_wall_time: 99999999999999, hlc_counter: 10 });
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
  });

  it('commits effective history and widget counts with accepted evidence without changing raw payload bytes', async () => {
    h.clock.utcMs = Date.UTC(2026, 8, 8, 16);
    h.clock.zone = 'UTC';
    const board: Board = { id: source.boardId, kind: 'count', title: 'received habit', symbol: 'star.fill',
      accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, amountUnit: null,
      quickAmount: 1, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, orderKey: 'a0',
      archivedAt: null, createdAt: 1, updatedAt: 1, mutationStamp: '00000000000001-00000-fixture',
      deletedAt: null, anchorRelation: null, anchorKind: null, anchorBoardId: null, anchorPreset: null,
      anchorText: null, usualTimeMinute: null, requiredInStack: true, earnsCoins: true, coinCapPerDay: 1 };
    await insertBoard(h.db, board);
    await insertCheckIn(h.db, { id: source.checkInId!, boardId: source.boardId,
      logicalDate: source.logicalDate, occurredAtUtc: null, timeZoneId: null, offsetMinutes: null,
      amount: null, note: 'retained note', source: 'sync', idempotencyKey: source.commandId!,
      createdAt: source.createdAt, updatedAt: source.createdAt, mutationStamp: source.mutationStamp, deletedAt: null });
    await rebuildWidgetRows(h.db, h.clock.utcMs, 'UTC');
    const raw = await h.db.getFirstAsync<Record<string, unknown>>('SELECT * FROM check_ins');
    expect(raw?.state_suppressed).toBe(1);
    expect((await readWidgetRows(h.db))[0].strip).toEqual([0, 0, 0, 0, 0, 0, 0]);
    await seed(h);
    expect(await run()).toMatchObject({ ok: true, value: { localChanged: true } });
    expect(await h.db.getFirstAsync('SELECT * FROM check_ins')).toEqual({ ...raw, state_suppressed: 0 });
    expect((await dailyCounts(h.db, source.boardId, source.logicalDate, source.logicalDate)).get(source.logicalDate)).toBe(1);
    expect((await readWidgetRows(h.db))[0].strip).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
  });

  it('rolls back a failure reported after actual hlc writes and retries without duplication', async () => {
    await seed(h, true);
    const before = await snapshot();
    const failure = new Error('private sqlite detail');
    const original = h.db.runAsync.bind(h.db);
    const write = jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (sql.includes('SET hlc_wall_time')) {
        expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
        throw failure;
      }
      return result;
    });
    expect(await run()).toMatchObject({ ok: false, error: { code: 'database', retryable: true,
      message: 'Local data could not be processed. Try again.' } });
    expect(await snapshot()).toEqual(before);
    expect(transport.ensureZoneCalls).toBe(0);
    write.mockRestore();
    expect(await run()).toMatchObject({ ok: true, value: { localChanged: true } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toHaveLength(1);
  });

  it('unwraps one provider failure layer after rollback, even when the original cause is a wrapper', async () => {
    await seed(h);
    const before = await snapshot();
    const cause = new RemoteFactHashingError(new Error('original provider failure'));
    const hash = jest.spyOn(h.deps.hashing, 'sha256').mockRejectedValue(cause);
    await expect(recoverLocalFacts(h.deps, () => {})).rejects.toBe(cause);
    expect(await snapshot()).toEqual(before);
    hash.mockRestore();
    expect(await run()).toMatchObject({ ok: true, value: { localChanged: true } });
  });

  it.each(['resolve', 'reject'])('cancels a held hash that later %s without accepting evidence or advancing markers', async outcome => {
    await seed(h);
    const before = await snapshot();
    let entered!: () => void;
    let release!: () => void;
    let current = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = h.deps.hashing.sha256;
    const hash = jest.spyOn(h.deps.hashing, 'sha256').mockImplementationOnce(async bytes => {
      entered(); await held;
      if (outcome === 'reject') throw new Error('retired provider failure');
      return original(bytes);
    });
    const running = runSync({ ...h.deps, transport, random: () => 0, shouldContinue: () => current });
    await started;
    current = false;
    release();
    expect(await running).toMatchObject({ ok: true, value: { status: 'idle', localChanged: false } });
    expect(await snapshot()).toEqual(before);
    expect(transport.ensureZoneCalls).toBe(0);
    hash.mockRestore();
    expect(await run()).toMatchObject({ ok: true, value: { localChanged: true } });
  });

  it('cancels after the final projection write before committing accepted facts or the clock', async () => {
    await seed(h);
    const before = await snapshot();
    let current = true;
    const original = h.db.runAsync.bind(h.db);
    jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (sql.includes('DELETE FROM widget_board_rows')) current = false;
      return result;
    });
    expect(await runSync({ ...h.deps, transport, random: () => 0, shouldContinue: () => current }))
      .toMatchObject({ ok: true, value: { status: 'idle', localChanged: false } });
    expect(current).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('fails atomically when the settings row disappears before acquisition', async () => {
    await seed(h);
    await h.db.runAsync('DELETE FROM app_settings');
    const before = await snapshot();
    await expect(recoverLocalFacts(h.deps, () => {})).rejects.toThrow('The database is not initialized.');
    expect(await snapshot()).toEqual(before);
  });
});
