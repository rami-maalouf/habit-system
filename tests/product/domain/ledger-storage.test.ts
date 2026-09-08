import { canonicalCoinLedger, checkCoinRow } from '@/core/domain/coin-ledger';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import type { HabitAction } from '@/core/domain/habit-actions';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { appendLedgerEntry, getLedgerEntry, listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const boardId = '00000000-0000-4000-8000-000000000001';
const logicalDate = '2026-09-08';
const scope = `check:${boardId}:${logicalDate}`;

async function award(h: TestHarness, index = 1, date = logicalDate): Promise<CoinLedgerRow> {
  const action: HabitAction = {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as HabitAction['id'],
    boardId: boardId as HabitAction['boardId'], logicalDate: date as HabitAction['logicalDate'],
    commandId: h.ids.nextCommandId(), checkInId: h.ids.uuid() as HabitAction['checkInId'],
    kind: 'check', createdAt: index,
    mutationStamp: `${String(index).padStart(14, '0')}-00000-history`,
    policyJson: canonicalCoinPolicy({ version: 1, boardKind: 'count', earnsCoins: true,
      coinCapPerDay: 10, checkClosesAtUtc: 200, rootId: null, requiredBoardIds: [],
      bonusClosesAtUtc: null, bonusEnabled: false }),
  };
  return checkCoinRow(action, h.deps.hashing);
}

describe('append-only ledger storage', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('retains exact immutable history without live parent rows and replays equal payloads', async () => {
    const row = await award(h);
    expect(await appendLedgerEntry(h.db, row)).toBe(true);
    expect(await appendLedgerEntry(h.db, { ...row })).toBe(false);
    expect(await getLedgerEntry(h.db, row.id)).toEqual(row);
    expect(canonicalCoinLedger((await getLedgerEntry(h.db, row.id))!)).toBe(canonicalCoinLedger(row));
    expect(await h.db.getAllAsync('SELECT * FROM boards')).toEqual([]);
    expect(await h.db.getAllAsync('SELECT * FROM check_ins')).toEqual([]);
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM coin_ledger')).toEqual({ count: 1 });
  });

  it('rejects unequal payloads for an existing id without changing accepted evidence', async () => {
    const row = await award(h);
    await appendLedgerEntry(h.db, row);
    await expect(appendLedgerEntry(h.db, { ...row, createdAt: row.createdAt + 1 })).rejects.toThrow('Immutable');
    expect(await getLedgerEntry(h.db, row.id)).toEqual(row);
    await expect(appendLedgerEntry(h.db, { ...row, delta: 0 })).rejects.toThrow();
    expect(await listLedgerEntriesForScope(h.db, scope)).toEqual([row]);
  });

  it('reads one scope in immutable action order and returns null for an absent row', async () => {
    const first = await award(h, 1);
    const second = await award(h, 2);
    const other = await award(h, 3, '2026-09-07');
    await appendLedgerEntry(h.db, second);
    await appendLedgerEntry(h.db, other);
    await appendLedgerEntry(h.db, first);
    expect(await listLedgerEntriesForScope(h.db, scope)).toEqual([first, second]);
    expect(await listLedgerEntriesForScope(h.db, `check:${boardId}:2026-09-06`)).toEqual([]);
    expect(await getLedgerEntry(h.db, h.ids.uuid() as CoinLedgerRow['id'])).toBeNull();
  });

  it('rolls back appended evidence with its enclosing writer transaction', async () => {
    const row = await award(h);
    await expect(h.db.withExclusiveTransactionAsync(async tx => {
      await appendLedgerEntry(tx, row);
      throw new Error('later writer failed');
    })).rejects.toThrow('later writer failed');
    expect(await getLedgerEntry(h.db, row.id)).toBeNull();
    expect(await appendLedgerEntry(h.db, row)).toBe(true);
  });

  it.each(['update', 'delete', 'replace'])('refuses direct SQL %s of accepted evidence', async operation => {
    const row = await award(h);
    await appendLedgerEntry(h.db, row);
    const sql = {
      update: 'UPDATE coin_ledger SET delta = -1 WHERE id = ?',
      delete: 'DELETE FROM coin_ledger WHERE id = ?',
      replace: 'INSERT OR REPLACE INTO coin_ledger SELECT * FROM coin_ledger WHERE id = ?',
    }[operation]!;
    await expect(h.db.runAsync(sql, [row.id])).rejects.toThrow('coin ledger is immutable');
    expect(await getLedgerEntry(h.db, row.id)).toEqual(row);
  });

  it.each([
    { delta: 0 }, { delta: -1 }, { delta: 2 }, { delta: 0.5 },
    { delta: Number.MAX_SAFE_INTEGER + 1 }, { delta: 'many' },
    { created_at: -1 }, { created_at: 0.5 }, { created_at: Number.MAX_SAFE_INTEGER + 1 },
    { deleted_at: 1 }, { board_id: null }, { check_in_id: null }, { scope_key: null },
    { source_action_id: null }, { reward_id: boardId }, { run_key: 'unrelated' },
    { reverses_id: boardId }, { adjusts_id: boardId }, { provenance_json: '{}' },
    { reconciliation_key: 'unexpected' }, { kind: 'unknown' },
    { kind: 'run_bonus', board_id: null, check_in_id: null, run_key: `${boardId}|${logicalDate}`,
      scope_key: `bonus:${boardId}:${logicalDate}`, delta: 2 },
  ])('rejects invalid raw ledger values %j before they enter storage', async change => {
    const row = await award(h);
    await appendLedgerEntry(h.db, row);
    const saved = (await h.db.getFirstAsync<Record<string, string | number | null>>('SELECT * FROM coin_ledger'))!;
    const invalid = { ...saved, id: h.ids.uuid(), ...change };
    const columns = Object.keys(invalid);
    await expect(h.db.runAsync(`INSERT INTO coin_ledger (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`, Object.values(invalid)))
      .rejects.toThrow('CHECK constraint failed');
    expect(await h.db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([saved]);
  });

  it('retains each row role and Unicode claim snapshots without requiring live objects', async () => {
    const check = await award(h);
    const bonus: CoinLedgerRow = { ...check, kind: 'run_bonus', boardId: null, checkInId: null,
      runKey: `${boardId}|${logicalDate}`, scopeKey: `bonus:${boardId}:${logicalDate}` };
    const claim: CoinLedgerRow = { ...check, id: h.ids.uuid() as CoinLedgerRow['id'], kind: 'claim',
      delta: -7, boardId: null, checkInId: null, scopeKey: null, sourceActionId: null,
      rewardId: h.ids.uuid() as CoinLedgerRow['rewardId'], rewardTitleSnapshot: 'Café 漫画 𝄞' };
    const rows = [bonus, claim, ...fixture.cases[2].ordinaryRows, ...fixture.overlap.expectedAppend] as CoinLedgerRow[];
    expect(new Set(rows.map(row => row.kind))).toEqual(new Set(['check', 'run_bonus', 'claim', 'reversal', 'adjustment']));
    for (const row of rows) {
      expect(await appendLedgerEntry(h.db, row)).toBe(true);
      expect(await getLedgerEntry(h.db, row.id)).toEqual(row);
      expect(await appendLedgerEntry(h.db, row)).toBe(false);
    }
    await expect(appendLedgerEntry(h.db, { ...claim, rewardTitleSnapshot: 'Cafe\u0301 漫画 𝄞' }))
      .rejects.toThrow('Immutable');
    expect(await getLedgerEntry(h.db, claim.id)).toEqual(claim);
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM coin_ledger')).toEqual({ count: rows.length });
  });
});
