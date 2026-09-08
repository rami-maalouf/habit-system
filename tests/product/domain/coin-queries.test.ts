import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import checkFixture from '@/core/automations/fixtures/check-coins.json';
import { archiveBoard, createBoard, createCheckIn, deleteBoard, removeCheckIn, updateBoard } from '@/core/domain/commands';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { getCoinHistoryPage, getCoinTotals, type CoinHistoryCursor } from '@/core/domain/coin-queries';
import { uuidV5 } from '@/core/domain/deterministic-ids';
import type { BoardId, LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import { getBoardById } from '@/core/persistence/repositories/boards';
import { appendLedgerEntry } from '@/core/persistence/repositories/ledger';

import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const boardId = '10000000-0000-4000-8000-000000000001' as BoardId;
const rewardId = '10000000-0000-4000-8000-000000000002' as RewardId;
const day = '2026-09-08' as LogicalDate;
const fields = { title: 'Reading', symbol: 'book.fill', accentHex: '#70A7FF', usesTintedBackground: false,
  tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true, earnsCoins: true };

describe('coin presentation queries', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });

  async function entry(index: number, changes: Partial<CoinLedgerRow> = {}) {
    const row: CoinLedgerRow = { ...checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow,
      id: await uuidV5(`coin-history-${index}`, h.deps.hashing) as LedgerEntryId,
      boardId, scopeKey: `check:${boardId}:${day}`, logicalDate: day, createdAt: index, ...changes };
    await appendLedgerEntry(h.db, row);
    return row;
  }
  async function snapshot() {
    return Promise.all(['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'app_settings', 'mutation_outbox',
      'command_receipts', 'widget_board_rows'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
  }
  async function page(input?: Parameters<typeof getCoinHistoryPage>[1]) {
    const result = await getCoinHistoryPage(h.deps, input);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  it('returns zero totals and empty history without creating any evidence', async () => {
    const before = await snapshot();
    expect(await getCoinTotals(h.deps)).toEqual({ ok: true, value: { earned: 0, spent: 0, balance: 0 } });
    expect(await page()).toEqual({ items: [], nextCursor: null });
    expect(await snapshot()).toEqual(before);
  });

  it('shows actual check, timely reversal and recheck earnings with retained habit metadata', async () => {
    const created = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId() });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.boardId;
    const first = await createCheckIn(h.deps, { boardId: id, commandId: h.ids.nextCommandId(), source: 'app' });
    if (!first.ok) throw new Error(first.error.message);
    expect((await removeCheckIn(h.deps, { commandId: h.ids.nextCommandId(), checkInId: first.value.checkInId })).ok).toBe(true);
    expect((await createCheckIn(h.deps, { boardId: id, commandId: h.ids.nextCommandId(), source: 'app' })).ok).toBe(true);
    const before = await snapshot();
    expect(await getCoinTotals(h.deps)).toEqual({ ok: true, value: { earned: 2, spent: 1, balance: 1 } });
    const history = await page();
    expect(history.items).toHaveLength(3);
    expect(history.items.map(row => row.kind).sort()).toEqual(['check', 'check', 'reversal']);
    for (const row of history.items) expect(row.reference).toEqual({ kind: 'habit', id, title: 'Reading', status: 'active' });
    expect(await snapshot()).toEqual(before);
  });

  it('includes raw corrections and cancellations in both totals, negative balance and history', async () => {
    const check = await entry(1);
    const bonus = await entry(2, { kind: 'run_bonus', boardId: null, checkInId: null, runKey: `${boardId}|${day}`, scopeKey: `bonus:${boardId}:${day}` });
    const reversal = await entry(3, { kind: 'reversal', delta: -1, boardId: null, checkInId: null, reversesId: bonus.id, scopeKey: bonus.scopeKey });
    const claim = await entry(4, { id: h.ids.uuid() as LedgerEntryId, kind: 'claim', delta: -7, boardId: null, checkInId: null,
      scopeKey: null, sourceActionId: null, rewardId: rewardId, rewardTitleSnapshot: 'Café 漫画 𝄞' });
    const correction = await entry(5, { kind: 'adjustment', delta: -2, boardId: null, checkInId: null, sourceActionId: null,
      reconciliationKey: 'a'.repeat(64), provenanceJson: '{"version":1,"facts":[]}' });
    const cancelled = await entry(6, { ...correction, id: await uuidV5('cancel-history', h.deps.hashing) as LedgerEntryId,
      createdAt: 6, delta: 2, adjustsId: correction.id });
    const restored = await entry(7, { ...correction, id: await uuidV5('restore-history', h.deps.hashing) as LedgerEntryId, createdAt: 7, delta: 3 });
    const before = await snapshot();
    expect(await getCoinTotals(h.deps)).toEqual({ ok: true, value: { earned: 7, spent: 10, balance: -3 } });
    const history = await page();
    expect(history.items.map(row => row.id)).toEqual([restored.id, cancelled.id, correction.id, claim.id, reversal.id, bonus.id, check.id]);
    expect(history.items.map(row => row.adjustment)).toEqual(['correction', 'cancellation', 'correction', null, null, null, null]);
    expect(history.items[3].reference).toEqual({ kind: 'reward', id: claim.rewardId, title: claim.rewardTitleSnapshot });
    expect(history.items[4].reference).toEqual({ kind: 'stack', id: boardId, title: null, status: 'missing' });
    expect(history.items[6].reference).toEqual({ kind: 'habit', id: boardId, title: null, status: 'missing' });
    expect(await snapshot()).toEqual(before);
  });

  it('uses stable date, timestamp and binary ID ordering with exact page lookahead', async () => {
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'AAAAAAAA-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-5000-8000-000000000001', 'AAAAAAAA-0000-5000-8000-000000000001'];
    const tied = [];
    for (const [index, id] of ids.entries()) {
      const claim = id.includes('-4000-');
      tied.push(await entry(index, claim ? { id: id as LedgerEntryId, kind: 'claim', delta: -1, boardId: null, checkInId: null,
        scopeKey: null, sourceActionId: null, rewardId: rewardId, rewardTitleSnapshot: 'Reward', createdAt: 0 } : { id: id as LedgerEntryId, createdAt: 0 }));
    }
    const ancient = await entry(10, { logicalDate: '0000-02-29' as LogicalDate, scopeKey: `check:${boardId}:0000-02-29`, createdAt: 999 });
    const expected = [...ids].sort().reverse();
    const first = await page({ limit: 2 });
    expect(first.items.map(row => row.id)).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).toEqual({ logicalDate: day, createdAt: 0, id: expected[1] });
    const second = await page({ limit: 2, before: first.nextCursor! });
    expect(second.items.map(row => row.id)).toEqual(expected.slice(2));
    const third = await page({ limit: 1, before: second.nextCursor! });
    expect(third.items.map(row => row.id)).toEqual([ancient.id]);
    expect(third.nextCursor).toBeNull();
    expect(await page({ before: { logicalDate: ancient.logicalDate, createdAt: ancient.createdAt, id: ancient.id } })).toEqual({ items: [], nextCursor: null });
    expect(tied).toHaveLength(4);
  });

  it('keeps existing pages stable when new rows arrive above or below their cursor', async () => {
    const first = await entry(30); const last = await entry(10);
    const initial = await page({ limit: 1 });
    const newer = await entry(40); const between = await entry(20);
    const older = await page({ limit: 10, before: initial.nextCursor! });
    expect(initial.items.map(row => row.id)).toEqual([first.id]);
    expect(older.items.map(row => row.id)).toEqual([between.id, last.id]);
    expect((await page({ limit: 1 })).items[0].id).toBe(newer.id);
  });

  it.each([null, [], { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { limit: null }, { unexpected: true },
    { before: null }, { before: {} }, { before: { logicalDate: '2026-02-30', createdAt: 0, id: boardId } },
    { before: { logicalDate: day, createdAt: -1, id: boardId } }, { before: { logicalDate: day, createdAt: -0, id: boardId } },
    { before: { logicalDate: day, createdAt: Number.MAX_SAFE_INTEGER + 1, id: boardId } },
    { before: { logicalDate: day, createdAt: 0, id: ['00000000-0000-4000-8000-000000000001'] } },
    { before: { logicalDate: day, createdAt: 0, id: 'bad' } },
    { before: { logicalDate: day, createdAt: 0, id: boardId, extra: true } },
    { before: Object.assign(Object.create({ id: boardId }), { logicalDate: day, createdAt: 0, unrelated: true }) },
  ])('rejects invalid paging input before reading SQL: %j', async input => {
    const reads = jest.spyOn(h.db, 'getAllAsync');
    const result = await getCoinHistoryPage(h.deps, input as Parameters<typeof getCoinHistoryPage>[1]);
    expect(result).toMatchObject({ ok: false, error: { code: 'validation', retryable: false } });
    expect(reads).not.toHaveBeenCalled();
  });
  it('retains archived and deleted titles and handles absent roots without following current topology', async () => {
    const created = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId() });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.boardId;
    await entry(1, { kind: 'run_bonus', boardId: null, checkInId: null, runKey: `${id}|${day}`, scopeKey: `bonus:${id}:${day}` });
    expect((await page()).items[0].reference).toEqual({ kind: 'stack', id, title: 'Reading', status: 'active' });
    expect((await archiveBoard(h.deps, { boardId: id, commandId: h.ids.nextCommandId() })).ok).toBe(true);
    expect((await page()).items[0].reference).toEqual({ kind: 'stack', id, title: 'Reading', status: 'archived' });
    expect((await deleteBoard(h.deps, { boardId: id, commandId: h.ids.nextCommandId() })).ok).toBe(true);
    expect((await page()).items[0].reference).toEqual({ kind: 'stack', id, title: 'Reading', status: 'deleted' });
    await h.db.runAsync('UPDATE boards SET title = ? WHERE id = ?', ['', id]);
    expect((await page()).items[0].reference).toEqual({ kind: 'stack', id, title: '', status: 'deleted' });
  });

  it('keeps ledger rows and retained titles in one WAL snapshot', async () => {
    const created = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId() });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.boardId;
    await entry(1, { boardId: id, scopeKey: `check:${id}:${day}` });
    const directory = mkdtempSync(join(tmpdir(), 'habit-coin-query-'));
    const path = join(directory, 'snapshot.sqlite');
    await h.db.runAsync('VACUUM INTO ?', [path]);
    const reader = new NodeSqlDatabase(path); const writer = new NodeSqlDatabase(path);
    try {
      await reader.execAsync('PRAGMA journal_mode = WAL');
      const original = reader.getAllAsync.bind(reader);
      const intercepted = jest.spyOn(reader, 'getAllAsync').mockImplementationOnce(async (sql, params) => {
        const result = await original(sql, params);
        const board = (await getBoardById(writer, id))!;
        const update = await updateBoard({ ...h.deps, db: writer }, { ...board, boardId: id, title: 'Renamed',
          commandId: h.ids.nextCommandId(), expectedMutationStamp: board.mutationStamp });
        expect(update.ok).toBe(true);
        return result;
      });
      expect(await getCoinHistoryPage({ db: reader, clock: h.clock })).toMatchObject({ ok: true, value: { items: [{ reference: { title: 'Reading' } }] } });
      intercepted.mockRestore();
      expect(await getCoinHistoryPage({ db: reader, clock: h.clock })).toMatchObject({ ok: true, value: { items: [{ reference: { title: 'Renamed' } }] } });
    } finally {
      await reader.closeAsync(); await writer.closeAsync();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps default and deep pages bounded and indexed without loading large proof payloads', async () => {
    await h.db.withExclusiveTransactionAsync(async () => {
      for (let index = 1; index <= 240; index += 1) await entry(index);
    });
    const proof = JSON.stringify({ version: 1, facts: Array.from({ length: 1500 }, (_, index) =>
      ['habit_action', `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'a'.repeat(64)]) });
    await entry(241, { kind: 'adjustment', delta: 1, boardId: null, checkInId: null, sourceActionId: null,
      reconciliationKey: 'b'.repeat(64), provenanceJson: proof });
    const read = jest.spyOn(h.db, 'getAllAsync');
    const first = await page();
    expect(first.items).toHaveLength(50);
    const expected = await h.db.getAllAsync<{ id: LedgerEntryId }>('SELECT id FROM coin_ledger ORDER BY logical_date DESC, created_at DESC, id DESC');
    const seen = first.items.map(item => item.id);
    let cursor: CoinHistoryCursor | null = first.nextCursor;
    while (cursor) {
      const next = await page({ limit: 100, before: cursor });
      seen.push(...next.items.map(item => item.id)); cursor = next.nextCursor;
    }
    expect(seen).toEqual(expected.map(row => row.id));
    const queryCalls = read.mock.calls.filter(([sql]) => sql.includes('LIMIT ?'));
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls.map(([, params]) => params!.at(-1))).toEqual([51, 101, 101]);
    for (const [sql, params] of queryCalls) {
      expect(sql).not.toMatch(/SELECT \*|provenance_json|habit_actions|check_ins|rewards/);
      const plan = await h.db.getAllAsync<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      expect(plan.some(row => row.detail.includes('idx_coin_ledger_history'))).toBe(true);
      expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
    }
    expect(read.mock.calls.filter(([sql]) => sql.includes('FROM boards'))).toHaveLength(3);
    expect(JSON.stringify(first)).not.toContain(proof);
    expect(JSON.stringify(first).length).toBeLessThan(25_000);
  });

  it('reports unsupported totals without rounding, and preserves SQLite integer-overflow errors', async () => {
    const huge = await entry(1, { kind: 'adjustment', delta: Number.MAX_SAFE_INTEGER, boardId: null, checkInId: null,
      sourceActionId: null, reconciliationKey: 'a'.repeat(64), provenanceJson: '{"version":1,"facts":[]}' });
    expect(await getCoinTotals(h.deps)).toEqual({ ok: true, value: { earned: Number.MAX_SAFE_INTEGER, spent: 0, balance: Number.MAX_SAFE_INTEGER } });
    await entry(2);
    expect(await getCoinTotals(h.deps)).toMatchObject({ ok: false, error: { code: 'capacity', retryable: false } });
    await h.db.runAsync(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM copies WHERE n < 1025)
      INSERT INTO coin_ledger SELECT printf('%08x-0000-5000-8000-000000000000', n), kind, delta, board_id, check_in_id,
        run_key, reward_id, reward_title_snapshot, reverses_id, scope_key, source_action_id, reconciliation_key,
        adjusts_id, provenance_json, logical_date, created_at, mutation_stamp, deleted_at
      FROM coin_ledger, copies WHERE id = ?`, [huge.id]);
    expect(await getCoinTotals(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true, message: expect.stringContaining('integer overflow') } });
  });

  it('rejects an unsafe spent aggregate even when the resulting balance would be finite', async () => {
    await entry(1, { id: h.ids.uuid() as LedgerEntryId, kind: 'claim', delta: -Number.MAX_SAFE_INTEGER,
      boardId: null, checkInId: null, scopeKey: null, sourceActionId: null, rewardId: rewardId, rewardTitleSnapshot: 'Reward' });
    await entry(2, { id: h.ids.uuid() as LedgerEntryId, kind: 'claim', delta: -1,
      boardId: null, checkInId: null, scopeKey: null, sourceActionId: null, rewardId: rewardId, rewardTitleSnapshot: 'Reward' });
    expect(await getCoinTotals(h.deps)).toMatchObject({ ok: false, error: { code: 'capacity' } });
  });

  it('returns retryable query failures and succeeds on the next attempt', async () => {
    await entry(1);
    jest.spyOn(h.db, 'getFirstAsync').mockRejectedValueOnce(new Error('storage interrupted'));
    expect(await getCoinTotals(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await getCoinTotals(h.deps)).toMatchObject({ ok: true, value: { balance: 1 } });
    jest.spyOn(h.db, 'getAllAsync').mockRejectedValueOnce(new Error('history interrupted'));
    expect(await getCoinHistoryPage(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect((await page()).items).toHaveLength(1);
  });

  it.each([
    { id: 'bad' }, { logical_date: '2026-02-30' }, { scope_key: 'bad' },
    { scope_key: `bonus:${boardId}:${day}` }, { scope_key: `check:${boardId}:2026-09-07` },
  ])('rejects malformed stored presentation fields without hiding them: %j', async changes => {
    await entry(1);
    const saved = (await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM coin_ledger'))!;
    const invalid = { ...saved, id: await uuidV5('invalid-row', h.deps.hashing), ...changes };
    const columns = Object.keys(invalid);
    await h.db.runAsync(`INSERT INTO coin_ledger (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(invalid));
    expect(await getCoinHistoryPage(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
  });

  it('rejects unreadable scope storage before rendering a fabricated reference', async () => {
    await entry(1);
    const saved = (await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM coin_ledger'))!;
    const invalid = { ...saved, id: await uuidV5('blob-scope', h.deps.hashing) };
    const keys = Object.keys(invalid);
    await h.db.runAsync(`INSERT INTO coin_ledger (${keys.join(',')}) VALUES (${keys.map(key => key === 'scope_key' ? "X'00'" : '?').join(',')})`,
      keys.filter(key => key !== 'scope_key').map(key => invalid[key as keyof typeof invalid]));
    expect(await getCoinHistoryPage(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
  });

  it('rejects malformed claim display fields while requiring no rewards table', async () => {
    const claim = await entry(1, { id: h.ids.uuid() as LedgerEntryId, kind: 'claim', delta: -1,
      boardId: null, checkInId: null, scopeKey: null, sourceActionId: null, rewardId, rewardTitleSnapshot: 'Reward' });
    const saved = (await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM coin_ledger WHERE id = ?', [claim.id]))!;
    const invalid = { ...saved, id: h.ids.uuid(), reward_title_snapshot: ' ' };
    await h.db.runAsync(`INSERT INTO coin_ledger (${Object.keys(invalid).join(',')}) VALUES (${Object.keys(invalid).map(() => '?').join(',')})`, Object.values(invalid));
    expect(await getCoinHistoryPage(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
  });

  it('rejects unreadable retained title metadata while preserving ledger evidence', async () => {
    const created = await createBoard(h.deps, { ...fields, commandId: h.ids.nextCommandId() });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.boardId;
    await entry(1, { boardId: id, scopeKey: `check:${id}:${day}` });
    const before = await h.db.getAllAsync('SELECT * FROM coin_ledger');
    await h.db.runAsync("UPDATE boards SET title = X'00' WHERE id = ?", [id]);
    expect(await getCoinHistoryPage(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual(before);
  });

});
