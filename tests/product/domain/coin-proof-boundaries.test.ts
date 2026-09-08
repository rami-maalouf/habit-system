import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinLedger, checkCoinRow } from '@/core/domain/coin-ledger';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { canonicalCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance, coinDigest, parseCoinProvenance } from '@/core/domain/coin-provenance';
import type { CoinFingerprint } from '@/core/domain/coin-provenance';
import { reconcileCheckCoins } from '@/core/domain/coin-reconciliation';
import type { CheckCoinScope } from '@/core/domain/coins';
import { uuidV5 } from '@/core/domain/deterministic-ids';
import type { HabitAction } from '@/core/domain/habit-actions';

const hashing = {
  sha1: async (bytes: Uint8Array) => new Uint8Array(createHash('sha1').update(bytes).digest()),
  sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()),
};
const scope = fixture.scope as CheckCoinScope;
const a = fixture.cases[0].actions[0] as HabitAction;
const b = fixture.correction.actions.find((value) => value.id !== a.id)! as HabitAction;
const removal = fixture.cases[2].actions[0] as HabitAction;
const award = fixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const reversal = fixture.cases[2].ordinaryRows[1] as CoinLedgerRow;
const correction = fixture.correction.expectedAppend[0] as CoinLedgerRow;
const raw = fixture.correction.existingRows as CoinLedgerRow[];
const run = (actions: HabitAction[], rows: CoinLedgerRow[]) => reconcileCheckCoins(scope, actions, rows, hashing);

async function withProof(facts: CoinFingerprint[]): Promise<CoinLedgerRow> {
  const provenanceJson = canonicalCoinProvenance(facts);
  const reconciliationKey = await coinDigest(provenanceJson, hashing);
  return { ...correction, provenanceJson, reconciliationKey,
    id: await uuidV5(JSON.stringify(['habit-ledger-v1', 'adjustment', correction.scopeKey, reconciliationKey]), hashing) as never };
}

describe('proof dependency and intrinsic source validation', () => {
  it('materializes missing genuine rows and validates an existing timely reversal', async () => {
    expect(await run([a], [])).toEqual({ appendedRows: [award], target: 1, balance: 1 });
    expect(await run([removal, a], [reversal, award])).toEqual({ appendedRows: [], target: 0, balance: 0 });
    const move = { ...removal, kind: 'move_out' as const };
    const moveRow = await checkCoinRow(move, hashing, award);
    expect(await run([move, a], [award, moveRow])).toEqual({ appendedRows: [], target: 0, balance: 0 });
    const clear = { ...removal, checkInId: null };
    const clearRow = await checkCoinRow(clear, hashing, award);
    expect(await run([clear, a], [award, clearRow])).toEqual({ appendedRows: [], target: 0, balance: 0 });
  });

  it('distinguishes missing ordinary dependencies from invalid intrinsic causes', async () => {
    for (const [actions, rows] of [[[], [award]], [[removal], [reversal]], [[removal], [reversal, award]]] as [HabitAction[], CoinLedgerRow[]][]) {
      await expect(run(actions, rows)).rejects.toMatchObject({ reason: 'missing' });
    }
    for (const source of [{ ...a, kind: 'move_in' }, { ...a, policyJson: null },
      { ...a, policyJson: canonicalCoinPolicy({ ...fixture.policy, earnsCoins: false }) }] as HabitAction[]) {
      await expect(run([source], [award])).rejects.toMatchObject({ reason: 'invalid' });
    }
    for (const cause of [{ ...removal, kind: 'check' }, { ...removal, checkInId: b.checkInId },
      { ...removal, createdAt: fixture.policy.checkClosesAtUtc }, { ...removal, mutationStamp: '01788825599999-00000-device' }] as HabitAction[]) {
      await expect(run([a, cause], [reversal, award])).rejects.toMatchObject({ reason: 'invalid' });
    }
    await expect(run([{ ...a, policyJson: null }, removal], [reversal, award])).rejects.toMatchObject({ reason: 'invalid' });
    const reversesReversal = { ...reversal, id: correction.id, reversesId: reversal.id };
    await expect(run([a, removal], [reversesReversal, reversal, award])).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects mismatched immutable payloads, foreign scopes and unsupported earning roles', async () => {
    await expect(run([a], [{ ...award, createdAt: award.createdAt + 1 }])).rejects.toMatchObject({ reason: 'invalid' });
    await expect(run([a], [award, { ...award, createdAt: award.createdAt + 1 }])).rejects.toMatchObject({ reason: 'invalid' });
    const foreign = { ...award, boardId: b.checkInId, scopeKey: `check:${b.checkInId}:${scope.logicalDate}` } as CoinLedgerRow;
    await expect(run([a], [foreign])).rejects.toMatchObject({ reason: 'invalid' });
    const bonus = fixture.shapeRows.find((row) => row.kind === 'run_bonus')! as CoinLedgerRow;
    await expect(run([a], [bonus])).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects wrong hashes, missing proof closure, missing canonical rows and zero corrections', async () => {
    const facts = parseCoinProvenance(correction.provenanceJson!);
    const badHash = facts.map((fact, index): CoinFingerprint => index ? fact : [fact[0], fact[1], 'f'.repeat(64)]);
    await expect(run([a, b], [...raw, await withProof(badHash)])).rejects.toMatchObject({ reason: 'invalid' });
    const noSource = facts.filter((fact) => !(fact[0] === 'habit_action' && fact[1] === a.id));
    await expect(run([a, b], [...raw, await withProof(noSource)])).rejects.toMatchObject({ reason: 'invalid' });
    const noCanonicalRow = facts.filter((fact) => !(fact[0] === 'ledger_entry' && fact[1] === award.id));
    await expect(run([a, b], [...raw, await withProof(noCanonicalRow)])).rejects.toMatchObject({ reason: 'invalid' });
    const zero = facts.filter((fact) => fact[1] === a.id || fact[1] === award.id);
    await expect(run([a], [award, await withProof(zero)])).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('waits for cancellation dependencies and strict supersets, and rejects altered cancellation payloads', async () => {
    const cancel: CoinLedgerRow = { ...correction, id: await uuidV5(`cancel:${correction.id}`, hashing) as never, delta: 1, adjustsId: correction.id };
    await expect(run([a, b], [...raw, cancel])).rejects.toMatchObject({ reason: 'missing' });
    await expect(run([a, b], [...raw, correction, cancel])).rejects.toMatchObject({ reason: 'missing' });
    await expect(run([a, b], [...raw, correction, { ...cancel, adjustsId: award.id }])).rejects.toMatchObject({ reason: 'invalid' });
    const union = fixture.overlap;
    await expect(run(union.actions as HabitAction[], [...union.existingRows, { ...cancel, delta: 2 }] as CoinLedgerRow[])).rejects.toMatchObject({ reason: 'invalid' });
    const cancellationOfCancellation = { ...cancel, id: await uuidV5(`cancel:${cancel.id}`, hashing) as never, adjustsId: cancel.id, delta: -1 };
    await expect(run(union.actions as HabitAction[], [...union.existingRows, cancel, cancellationOfCancellation] as CoinLedgerRow[])).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('cancels an old correction when a valid offline reversal makes the full-set correction zero', async () => {
    const removeB = { ...removal, checkInId: b.checkInId };
    const bAward = raw.find((row) => row.sourceActionId === b.id)!;
    const bReversal = await checkCoinRow(removeB, hashing, bAward);
    const result = await run([a, b, removeB], [...raw, bReversal, correction]);
    expect(result.target).toBe(1);
    expect(result.balance).toBe(1);
    expect(result.appendedRows).toHaveLength(1);
    expect(result.appendedRows[0]).toMatchObject({ kind: 'adjustment', delta: 1, adjustsId: correction.id });
    expect(canonicalCoinLedger(result.appendedRows[0])).toContain(correction.id);
    expect((await run([a, b, removeB], [...raw, bReversal, correction, ...result.appendedRows])).appendedRows).toEqual([]);
  });
});
