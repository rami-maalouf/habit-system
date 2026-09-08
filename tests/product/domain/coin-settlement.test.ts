import fixture from '@/core/automations/fixtures/check-coins.json';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { appendLocalLedgerEntry, settleCheckCoinScope } from '@/core/domain/coin-settlement';
import type { CheckCoinScope } from '@/core/domain/coins';
import type { HabitAction } from '@/core/domain/habit-actions';
import { appendHabitAction } from '@/core/persistence/repositories/habit-actions';
import { appendLedgerEntry, listLedgerEntriesForScope } from '@/core/persistence/repositories/ledger';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const scope = fixture.scope as CheckCoinScope;
const now = 1789000000000;
const tables = ['habit_actions', 'coin_ledger', 'mutation_outbox', 'app_settings', 'command_receipts'];
const snapshot = (h: TestHarness) => Promise.all(tables.map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY 1`)));

describe('transactional coin settlement', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it('queues immutable local evidence once using causal metadata and the supplied enqueue time', async () => {
    const row = fixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
    await h.db.withExclusiveTransactionAsync(async tx => {
      expect(await appendLocalLedgerEntry(tx, row, now)).toBe(true);
      expect(await appendLocalLedgerEntry(tx, row, now + 1)).toBe(false);
    });
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual([
      { id: 1, entity_type: 'ledger_entry', entity_id: row.id, mutation_stamp: row.mutationStamp, created_at: now },
    ]);
    expect(await listLedgerEntriesForScope(h.db, row.scopeKey!)).toEqual([row]);
  });

  it('settles a persisted cap race and replays without clocks, UUIDs, receipts or extra outbox entries', async () => {
    const vector = fixture.correction;
    for (const action of vector.actions) await appendHabitAction(h.db, action as HabitAction);
    for (const row of vector.existingRows) await appendLedgerEntry(h.db, row as CoinLedgerRow);
    const settings = await h.db.getFirstAsync('SELECT * FROM app_settings');
    jest.spyOn(h.ids, 'uuid').mockImplementation(() => { throw new Error('unexpected id allocation'); });
    jest.spyOn(h.clock, 'nowUtcMs').mockImplementation(() => { throw new Error('unexpected clock capture'); });
    jest.spyOn(h.clock, 'timeZoneId').mockImplementation(() => { throw new Error('unexpected zone capture'); });
    await h.db.withExclusiveTransactionAsync(async tx => {
      expect(await settleCheckCoinScope(h.deps, { tx, now }, scope)).toEqual({
        appendedRows: vector.expectedAppend, target: vector.target, balance: vector.balance,
      });
      expect(await settleCheckCoinScope(h.deps, { tx, now }, scope)).toEqual({ appendedRows: [], target: 1, balance: 1 });
    });
    expect(await h.db.getAllAsync('SELECT entity_id, mutation_stamp, created_at FROM mutation_outbox')).toEqual(
      vector.expectedAppend.map(row => ({ entity_id: row.id, mutation_stamp: row.mutationStamp, created_at: now })),
    );
    expect(await h.db.getFirstAsync('SELECT * FROM app_settings')).toEqual(settings);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual([]);
  });

  it('does no work for an empty scope and leaves other dates untouched', async () => {
    const action = fixture.cases[0].actions[0] as HabitAction;
    await appendHabitAction(h.db, action);
    const before = await snapshot(h);
    await h.db.withExclusiveTransactionAsync(async tx => {
      expect(await settleCheckCoinScope(h.deps, { tx, now }, { ...scope, logicalDate: '2026-09-07' as never }))
        .toEqual({ appendedRows: [], target: 0, balance: 0 });
    });
    expect(await snapshot(h)).toEqual(before);
  });

  it.each(['coin_ledger', 'mutation_outbox'])('rolls back action and economic evidence on %s failure, then retries once', async table => {
    const action = fixture.cases[0].actions[0] as HabitAction;
    const before = await snapshot(h);
    const run = h.db.runAsync.bind(h.db);
    const failure = jest.spyOn(h.db, 'runAsync').mockImplementation((sql, params) => {
      if (sql.includes(`INSERT INTO ${table}`)) return Promise.reject(new Error('simulated disk failure'));
      return run(sql, params);
    });
    const write = () => h.db.withExclusiveTransactionAsync(async tx => {
      await appendHabitAction(tx, action);
      return settleCheckCoinScope(h.deps, { tx, now }, scope);
    });
    await expect(write()).rejects.toThrow('simulated disk failure');
    expect(await snapshot(h)).toEqual(before);
    failure.mockRestore();
    expect(await write()).toMatchObject({ target: 1, balance: 1, appendedRows: fixture.cases[0].ordinaryRows });
    expect(await write()).toEqual({ appendedRows: [], target: 1, balance: 1 });
    expect(await h.db.getFirstAsync('SELECT COUNT(*) AS count FROM mutation_outbox')).toEqual({ count: 1 });
  });
});
