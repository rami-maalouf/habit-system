import fixture from '@/core/automations/fixtures/check-coins.json';
import { assertCoinLedgerShape, canonicalCoinLedger, coinLedgerTotals } from '@/core/domain/coin-ledger';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { COIN_RECORD_BYTES } from '@/core/domain/coin-policy';

const award = fixture.cases[0].ordinaryRows[0];

describe('immutable coin row shape', () => {
  it('retains every explicit field of a check and reversal', () => {
    for (const row of fixture.cases[2].ordinaryRows) expect(assertCoinLedgerShape(row)).toEqual(row);
    expect(JSON.parse(canonicalCoinLedger(assertCoinLedgerShape(award)))).toEqual(['habit-ledger-row-v1', ...Object.values(award)]);
  });
  it.each(fixture.canonicalRows)('retains reserved roles and exact canonical Unicode row $row.kind', ({ row, json }) => {
    expect(canonicalCoinLedger(assertCoinLedgerShape(row))).toBe(json);
  });
  it('rejects non-object inputs, wrong reserved roles and malformed references', () => {
    for (const value of [null, [], true, 'row', { ...award, id: 4 }, { ...award, sourceActionId: [] }]) expect(() => assertCoinLedgerShape(value)).toThrow('invalid');
    const claim = fixture.shapeRows.find((row) => row.kind === 'claim')!;
    for (const title of ['', ' space ', 'x'.repeat(81), '\uD800']) expect(() => assertCoinLedgerShape({ ...claim, rewardTitleSnapshot: title })).toThrow('invalid');
    expect(() => assertCoinLedgerShape({ ...claim, rewardId: 'bad' })).toThrow('invalid');
    const bonus = fixture.shapeRows.find((row) => row.kind === 'run_bonus')!;
    for (const change of [{ runKey: 'wrong' }, { scopeKey: bonus.scopeKey!.replace('bonus:', 'check:') }, { delta: -1 }]) expect(() => assertCoinLedgerShape({ ...bonus, ...change })).toThrow('invalid');
    const reversal = fixture.cases[2].ordinaryRows[1];
    expect(() => assertCoinLedgerShape({ ...reversal, reversesId: 'bad' })).toThrow('invalid');
    expect(() => assertCoinLedgerShape({ ...reversal, delta: 1 })).toThrow('invalid');
    const adjustment = fixture.correction.expectedAppend[0];
    expect(() => assertCoinLedgerShape({ ...adjustment, reconciliationKey: 'BAD' })).toThrow('invalid');
    expect(() => assertCoinLedgerShape({ ...adjustment, scopeKey: 'wrong' })).toThrow('invalid');
    expect(() => assertCoinLedgerShape({ ...adjustment, adjustsId: 'bad' })).toThrow('invalid');
  });
  it('enforces the full canonical record byte budget', () => {
    expect(() => assertCoinLedgerShape({ ...award, mutationStamp: `01788825600000-00000-${'x'.repeat(COIN_RECORD_BYTES)}` })).toThrow('size');
  });
  it('keeps raw positive and negative totals, negative balance, and refuses unsafe totals', () => {
    const claim = fixture.shapeRows.find((row) => row.kind === 'claim')! as CoinLedgerRow;
    const correction = fixture.correction.expectedAppend[0] as CoinLedgerRow;
    expect(coinLedgerTotals([award, claim, correction] as CoinLedgerRow[])).toEqual({ earned: 1, spent: 4, balance: -3 });
    expect(coinLedgerTotals([])).toEqual({ earned: 0, spent: 0, balance: 0 });
    expect(() => coinLedgerTotals([{ ...claim, delta: -Number.MAX_SAFE_INTEGER }, claim])).toThrow('invalid');
    expect(() => coinLedgerTotals([{ ...correction, delta: Number.MAX_SAFE_INTEGER }, award] as CoinLedgerRow[])).toThrow('invalid');
  });

  it.each([
    { id: 'bad' }, { id: '00000000-0000-4000-8000-000000000009' }, { kind: 'unknown' }, { delta: 0 },
    { delta: -1 }, { delta: 1.5 }, { delta: Number.MAX_SAFE_INTEGER + 1 }, { boardId: null }, { checkInId: null },
    { sourceActionId: null }, { sourceActionId: 'bad' }, { scopeKey: null }, { scopeKey: 'check:bad:2026-09-08' },
    { logicalDate: '2026-02-30' }, { createdAt: -1 }, { createdAt: 0.5 }, { mutationStamp: 'bad' }, { deletedAt: 1 },
    { runKey: 'unrelated' }, { rewardId: 'bad' }, { provenanceJson: '{}' }, { extra: true },
  ])('rejects malformed or wrong-role check row %j', (change) => {
    expect(() => assertCoinLedgerShape({ ...award, ...change })).toThrow('Coin evidence invalid');
  });
});
