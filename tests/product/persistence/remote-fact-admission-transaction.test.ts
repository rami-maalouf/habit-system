import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { CoinContractError } from '@/core/domain/coin-policy';
import type { Board, CheckIn } from '@/core/domain/entities';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { Hashing } from '@/core/domain/ports';
import { getGroupedCheckInHistory } from '@/core/domain/queries';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import type { RemoteFactCandidate } from '@/core/domain/remote-fact-validation';
import type { SqlExecutor } from '@/core/persistence/database';
import { rebuildWidgetRows, readWidgetRows } from '@/core/persistence/projections/widget-rows';
import { admitRemoteFacts, type RemoteFactAdmissionInput } from '@/core/persistence/remote-fact-admission';
import { insertBoard } from '@/core/persistence/repositories/boards';
import { insertCheckIn } from '@/core/persistence/repositories/check-ins';
import { refreshCheckVisibility } from '@/core/persistence/repositories/check-visibility';
import { listHabitActions } from '@/core/persistence/repositories/habit-actions';
import { getLedgerEntry } from '@/core/persistence/repositories/ledger';
import { getReceipt, getSettings, getSyncState, insertReceipt, saveHlc, saveSyncState } from '@/core/persistence/repositories/support';
import { observe } from '@/core/sync/hybrid-clock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const scope = { boardId: source.boardId, logicalDate: source.logicalDate };
const acquiredNow = Date.UTC(2026, 8, 8, 16);
const receiptId = '00000000-0000-4000-8000-000000009999';
const outcome = JSON.stringify({ ok: true, value: { page: 'received-page' } });
const sourceCandidate = (): RemoteFactCandidate => ({
  factType: 'habit_action', factId: source.id, value: { ...source }, enqueueOnAdmission: false,
});
const diagnosticCandidate = (): RemoteFactCandidate => ({
  factType: 'habit_action', factId: '00000000-0000-4000-8000-000000009998',
  value: { privateNote: 'invalid remote record retained only in the inbox' }, enqueueOnAdmission: false,
});
const payload: CheckIn = {
  id: source.checkInId!, ...scope, occurredAtUtc: null, timeZoneId: null, offsetMinutes: null,
  amount: null, note: 'received payload awaiting accepted evidence', source: 'sync',
  idempotencyKey: source.commandId!, createdAt: source.createdAt, updatedAt: source.createdAt,
  mutationStamp: source.mutationStamp, deletedAt: null,
};
const board: Board = {
  id: source.boardId, kind: 'count', title: 'received count habit', symbol: 'star.fill',
  accentHex: '#78D98B', usesTintedBackground: false, tracksAmount: false, amountUnit: null,
  quickAmount: 1, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, orderKey: 'a0',
  archivedAt: null, createdAt: 1, updatedAt: 1, mutationStamp: '00000000000001-00000-fixture',
  deletedAt: null, anchorRelation: null, anchorKind: null, anchorBoardId: null, anchorPreset: null,
  anchorText: null, usualTimeMinute: null, requiredInStack: true, earnsCoins: true, coinCapPerDay: 1,
};
const tables = ['boards', 'board_activity_periods', 'check_ins', 'habit_actions', 'coin_ledger',
  'remote_fact_inbox', 'mutation_outbox', 'app_settings', 'widget_board_rows', 'sync_state', 'command_receipts'];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('immutable admission inside the caller transaction', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await createTestHarness();
    h.clock.utcMs = acquiredNow;
    h.clock.zone = 'UTC';
    // this is a received mutable board, not a legacy check seed.
    await insertBoard(h.db, board);
    await rebuildWidgetRows(h.db, acquiredNow, 'UTC');
    await saveHlc(h.db, { wallTime: 7, counter: 3 });
    await saveSyncState(h.db, { changeToken: 'before-page', zoneCreated: true, retryState: null, lastSuccessAtUtc: 7 });
  });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  const snapshot = () => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  const queue = () => h.db.getAllAsync('SELECT entity_type, entity_id, mutation_stamp, created_at FROM mutation_outbox ORDER BY id');
  const history = () => getGroupedCheckInHistory(h.deps, source.boardId);

  async function finishPage(tx: SqlExecutor, result: Awaited<ReturnType<typeof admitRemoteFacts>>, checkpoint: () => void) {
    const settings = (await getSettings(tx))!;
    let hlc = { wallTime: settings.hlcWallTime, counter: settings.hlcCounter };
    for (const fact of [...result.admitted, ...result.generated]) hlc = observe(hlc, fact.mutationStamp);
    await saveHlc(tx, hlc);
    await refreshCheckVisibility(tx, result.affected.checkScopes);
    await rebuildWidgetRows(tx, acquiredNow, 'UTC');
    await saveSyncState(tx, { changeToken: 'received-page', zoneCreated: true, retryState: null, lastSuccessAtUtc: acquiredNow });
    await insertReceipt(tx, receiptId, outcome, acquiredNow);
    checkpoint();
  }

  function receive(candidates: RemoteFactCandidate[] = [sourceCandidate()], rawHashing = h.deps.hashing,
    checkpoint: () => void = () => {}) {
    return h.db.withExclusiveTransactionAsync(async tx => {
      checkpoint();
      await insertCheckIn(tx, payload);
      const result = await admitRemoteFacts(tx, { candidates, acquiredNow, checkScopes: [scope], checkpoint }, rawHashing);
      await finishPage(tx, result, checkpoint);
      return result;
    });
  }

  async function expectCommitted() {
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([source]);
    expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
    expect(await h.db.getFirstAsync('SELECT state_suppressed FROM check_ins WHERE id = ?', [payload.id]))
      .toEqual({ state_suppressed: 0 });
    expect(await history()).toEqual({ ok: true, value: { hasMore: false, months: [{
      month: '2026-09', count: 1, days: [{ date: source.logicalDate, count: 1, checkIns: [payload] }],
    }] } });
    expect(await readWidgetRows(h.db)).toEqual([{
      boardId: board.id, kind: 'count', position: 0, title: board.title, symbol: board.symbol,
      accentHex: board.accentHex, strip: [0, 0, 0, 0, 0, 0, 1], stripEndDate: source.logicalDate,
    }]);
    expect(await queue()).toEqual([{
      entity_type: 'ledger_entry', entity_id: award.id, mutation_stamp: award.mutationStamp, created_at: acquiredNow,
    }]);
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: 1788825600000, hlcCounter: 1 });
    expect(await getSyncState(h.db)).toEqual({
      changeToken: 'received-page', zoneCreated: true, retryState: null, lastSuccessAtUtc: acquiredNow,
    });
    expect(await h.db.getFirstAsync('SELECT * FROM command_receipts WHERE command_id = ?', [receiptId]))
      .toEqual({ command_id: receiptId, outcome, created_at: acquiredNow });
  }

  it('commits raw-only caller work while an empty drain keeps history hidden and manufactures no baseline or coin', async () => {
    const result = await receive([]);
    expect(result).toMatchObject({ admitted: [], generated: [], duplicates: [], localChanged: false,
      affected: { checkScopes: [scope], rootScopes: [] },
      counts: { variants: 0, payloadBytes: 0, pending: 0, blocked: 0, quarantined: 0 } });
    expect(await h.db.getFirstAsync('SELECT state_suppressed FROM check_ins WHERE id = ?', [payload.id]))
      .toEqual({ state_suppressed: 1 });
    expect(await history()).toEqual({ ok: true, value: { hasMore: false, months: [] } });
    expect((await readWidgetRows(h.db))[0].strip).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(await listHabitActions(h.db, source.boardId, source.logicalDate)).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    expect(await queue()).toEqual([]);
    expect(await getSettings(h.db)).toMatchObject({ hlcWallTime: 7, hlcCounter: 3 });
    expect(await getReceipt(h.db, receiptId)).toBe(outcome);
    expect((await getSyncState(h.db)).changeToken).toBe('received-page');
    const before = await snapshot();
    await h.db.withExclusiveTransactionAsync(async tx => {
      const drained = await admitRemoteFacts(tx, { candidates: [], acquiredNow, checkScopes: [scope] }, h.deps.hashing);
      expect(drained.localChanged).toBe(false);
      await refreshCheckVisibility(tx, drained.affected.checkScopes);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('admits literal genuine evidence, then commits public history, widgets, hlc and caller markers together', async () => {
    expect(await receive()).toMatchObject({
      admitted: [{ factType: 'habit_action', factId: source.id, mutationStamp: source.mutationStamp }],
      generated: [{ factType: 'ledger_entry', factId: award.id, mutationStamp: award.mutationStamp }],
      duplicates: [], localChanged: true,
    });
    await expectCommitted();
    const before = await snapshot();
    const replay = await h.db.withExclusiveTransactionAsync(tx => admitRemoteFacts(tx,
      { candidates: [sourceCandidate()], acquiredNow: acquiredNow + 1, checkScopes: [scope] }, h.deps.hashing));
    expect(replay).toMatchObject({ admitted: [], generated: [],
      duplicates: [{ factType: 'habit_action', factId: source.id }], localChanged: false });
    expect(await snapshot()).toEqual(before);
  });

  it('captures later batch values, scope seeds, enqueue intent, time and raw hash methods before the first hash await', async () => {
    const entered = deferred();
    const release = deferred();
    const later = { ...source };
    const laterCandidate: RemoteFactCandidate = {
      factType: 'habit_action', factId: source.id, value: later, enqueueOnAdmission: false,
    };
    const seed = { ...scope };
    const input: RemoteFactAdmissionInput = {
      candidates: [sourceCandidate(), laterCandidate], acquiredNow, checkScopes: [seed], checkpoint: () => {},
    };
    const raw: Hashing = { ...h.deps.hashing, sha256: async bytes => {
      entered.resolve();
      await release.promise;
      return h.deps.hashing.sha256(bytes);
    } };
    const poisoned = jest.fn(async (_bytes: Uint8Array): Promise<Uint8Array> => { throw new Error('replacement hash method'); });
    const pending = h.db.withExclusiveTransactionAsync(async tx => {
      await insertCheckIn(tx, payload);
      const result = await admitRemoteFacts(tx, input, raw);
      await finishPage(tx, result, () => {});
      return result;
    });
    await entered.promise;
    try {
      later.createdAt += 1;
      laterCandidate.enqueueOnAdmission = true;
      seed.logicalDate = '2026-09-07' as typeof seed.logicalDate;
      input.acquiredNow += 99;
      input.checkpoint = () => { throw new Error('replacement checkpoint'); };
      raw.sha1 = poisoned;
      raw.sha256 = poisoned;
    } finally { release.resolve(); }
    const result = await pending;
    expect(result.admitted).toEqual([{ factType: 'habit_action', factId: source.id, mutationStamp: source.mutationStamp }]);
    expect(result.duplicates).toEqual([]);
    expect(result.affected).toEqual({ checkScopes: [scope], rootScopes: [] });
    expect(result.counts).toMatchObject({ variants: 0, pending: 0, blocked: 0, quarantined: 0 });
    expect(poisoned).not.toHaveBeenCalled();
    await expectCommitted();
  });

  it.each(['habit_actions', 'coin_ledger', 'mutation_outbox', 'remote_fact_inbox', 'widget_board_rows', 'command_receipts'])(
    'rolls back all page work on an actual SQLite failure at %s, then retries the unchanged input', async table => {
      const candidates = [sourceCandidate(), diagnosticCandidate()];
      const before = await snapshot();
      await h.db.execAsync(`CREATE TRIGGER reject_admission_page AFTER INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'injected admission page failure'); END`);
      await expect(receive(candidates)).rejects.toThrow('injected admission page failure');
      expect(await snapshot()).toEqual(before);
      expect(await history()).toEqual({ ok: true, value: { hasMore: false, months: [] } });
      await h.db.execAsync('DROP TRIGGER reject_admission_page');
      const result = await receive(candidates);
      expect(result.counts).toMatchObject({ pending: 0, blocked: 0, quarantined: 1, variants: 1 });
      await expectCommitted();
      expect(await h.db.getAllAsync('SELECT state, reason FROM remote_fact_inbox'))
        .toEqual([{ state: 'quarantined', reason: 'invalid' }]);
    });

  it('rolls back an adapter error reported after the caller receipt, token and projection were actually written', async () => {
    const before = await snapshot();
    const failure = new Error('receipt response was lost');
    const run = h.db.runAsync.bind(h.db);
    let reachedPostwrite = false;
    jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await run(sql, params);
      if (sql.startsWith('INSERT INTO command_receipts')) {
        expect(await getReceipt(h.db, receiptId)).toBe(outcome);
        expect((await getSyncState(h.db)).changeToken).toBe('received-page');
        expect((await readWidgetRows(h.db))[0].strip[6]).toBe(1);
        expect(await getLedgerEntry(h.db, award.id)).toEqual(award);
        reachedPostwrite = true;
        throw failure;
      }
      return result;
    });
    await expect(receive()).rejects.toBe(failure);
    expect(reachedPostwrite).toBe(true);
    expect(await snapshot()).toEqual(before);
    jest.restoreAllMocks();
    await receive();
    await expectCommitted();
  });

  it('cancels a superseded generation held in hashing and rolls back its already received raw payload', async () => {
    const before = await snapshot();
    const entered = deferred();
    const release = deferred();
    let currentGeneration = 1;
    const cancellation = new Error('obsolete page generation');
    const checkpoint = () => { if (currentGeneration !== 1) throw cancellation; };
    const raw: Hashing = { ...h.deps.hashing, sha256: async bytes => {
      entered.resolve();
      await release.promise;
      return h.deps.hashing.sha256(bytes);
    } };
    const pending = receive([sourceCandidate()], raw, checkpoint);
    const rejected = expect(pending).rejects.toBe(cancellation);
    await entered.promise;
    try {
      expect(await h.db.getFirstAsync('SELECT state_suppressed FROM check_ins WHERE id = ?', [payload.id]))
        .toEqual({ state_suppressed: 1 });
      currentGeneration = 2;
    } finally { release.resolve(); }
    await rejected;
    expect(await snapshot()).toEqual(before);
    await receive();
    await expectCommitted();
  });

  it('checks the caller generation after awaited projection and marker work before committing', async () => {
    const before = await snapshot();
    const cancellation = new Error('page retired after its last awaited write');
    let current = true;
    const run = h.db.runAsync.bind(h.db);
    jest.spyOn(h.db, 'runAsync').mockImplementation(async (sql, params) => {
      const result = await run(sql, params);
      if (sql.startsWith('INSERT INTO command_receipts')) current = false;
      return result;
    });
    await expect(receive([sourceCandidate()], h.deps.hashing, () => {
      if (!current) throw cancellation;
    })).rejects.toBe(cancellation);
    expect(current).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  const providerCases: { name: string; method: keyof Hashing; cause: Error }[] = [
    { name: 'preparation invalid', method: 'sha256', cause: new CoinContractError('invalid') },
    { name: 'preparation missing', method: 'sha256', cause: new CoinContractError('missing') },
    { name: 'preparation size', method: 'sha256', cause: new CoinContractError('size') },
    { name: 'preparation abort', method: 'sha256', cause: Object.assign(new Error('provider abort'), { name: 'AbortError' }) },
    { name: 'provider-owned wrapper in preparation', method: 'sha256', cause: new RemoteFactHashingError(new Error('original provider cause')) },
    { name: 'settlement invalid', method: 'sha1', cause: new CoinContractError('invalid') },
    { name: 'provider-owned wrapper in settlement', method: 'sha1', cause: new RemoteFactHashingError(new Error('original settlement cause')) },
  ];

  it.each(providerCases)('preserves one owned wrapper for $name and unwraps only after rollback', async ({ method, cause }) => {
    const before = await snapshot();
    const provider = jest.fn(async (_bytes: Uint8Array): Promise<Uint8Array> => { throw cause; });
    const raw: Hashing = { ...h.deps.hashing, [method]: provider };
    let inside: unknown;
    let outside: unknown;
    try {
      await h.db.withExclusiveTransactionAsync(async tx => {
        await insertCheckIn(tx, payload);
        try {
          const result = await admitRemoteFacts(tx, { candidates: [sourceCandidate()], acquiredNow, checkScopes: [scope] }, raw);
          await finishPage(tx, result, () => {});
        } catch (error) {
          inside = error;
          expect(error).toBeInstanceOf(RemoteFactHashingError);
          expect((error as RemoteFactHashingError).cause).toBe(cause);
          expect(await tx.getFirstAsync('SELECT id FROM check_ins WHERE id = ?', [payload.id])).toEqual({ id: payload.id });
          throw error;
        }
      });
    } catch (error) {
      expect(error).toBe(inside);
      expect(await snapshot()).toEqual(before);
      // the caller removes exactly its operation wrapper after sqlite has rolled back.
      outside = error instanceof RemoteFactHashingError ? error.cause : error;
    }
    expect(provider).toHaveBeenCalled();
    expect(outside).toBe(cause);
    expect(await snapshot()).toEqual(before);
    await receive();
    await expectCommitted();
  });
});
