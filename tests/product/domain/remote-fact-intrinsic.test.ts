import { bonusAwardRow } from '@/core/domain/bonus-coin-causes';
import { canonicalCoinPolicy, COIN_POLICY_BYTES, COIN_RECORD_BYTES, parseCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance } from '@/core/domain/coin-provenance';
import { prepareCoinEvidence } from '@/core/domain/coin-reconciliation-core';
import { baselineAction } from '@/core/domain/habit-actions';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { planRemoteCoinScope } from '@/core/domain/remote-fact-scope-plan';
import checkFixture from '@/core/automations/fixtures/check-coins.json';
import bonusFixture from '@/core/automations/fixtures/bonus-coins.json';
import { checkCoinRow, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import type { HabitAction } from '@/core/domain/habit-actions';
import { prepareRemoteCoinIntrinsic } from '@/core/domain/remote-fact-intrinsic';
import type { RemoteCoinScope } from '@/core/domain/remote-fact-scope-inputs';
import type { CanonicalRemoteFact } from '@/core/domain/remote-fact-validation';

import { createTestHashing } from '../helpers/test-db';

const hashing = createTestHashing();
const scope = { kind: 'check', ...checkFixture.scope } as RemoteCoinScope;
const actions = checkFixture.correction.actions as HabitAction[];
const rows = checkFixture.correction.existingRows as CoinLedgerRow[];
const correction = checkFixture.correction.expectedAppend[0] as CoinLedgerRow;
const cancellation = checkFixture.overlap.expectedAppend[1] as CoinLedgerRow;
const removalVector = checkFixture.cases.find(item => item.name === 'targeted removal never promotes a cap-blocked check')!;
const reversal = removalVector.ordinaryRows[1] as CoinLedgerRow;
const fact = (value: HabitAction | CoinLedgerRow): CanonicalRemoteFact => 'commandId' in value
  ? { factType: 'habit_action', value } : { factType: 'ledger_entry', value };

it('classifies same-ID award alternatives independently without a last-write winner', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts: rows.map(fact) }, hashing);
  expect(Object.isFrozen(factory.context)).toBe(true);
  const invalid = { ...rows[0], createdAt: rows[0].createdAt + 1 };
  for (const candidates of [[rows[0], invalid], [invalid, rows[0]]]) {
    const actual = [];
    for (const row of candidates) actual.push((await factory.award(row)).status);
    expect(actual).toEqual(candidates.map(row => row === invalid ? 'invalid' : 'valid'));
  }
});

it('uses only the supplied resolved award and rejects a different typed reference as caller integrity', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: removalVector.actions as HabitAction[], knownFacts: [] }, hashing);
  expect(await factory.reversal(reversal, undefined)).toEqual({ status: 'pending' });
  expect((await factory.reversal(reversal, rows[0])).status).toBe('valid');
  await expect(factory.reversal(reversal, rows[1])).rejects.toMatchObject({ reason: 'integrity' });
});

it('retains self-reference role invalidity while excluding other same-ID alternatives', async () => {
  const row = { ...reversal, reversesId: reversal.id };
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: [], knownFacts: [] }, hashing);
  expect(await factory.reversal(row, undefined)).toEqual({ status: 'invalid' });
  const source = removalVector.actions.find(action => action.id === reversal.sourceActionId)! as HabitAction;
  const wrongRole = { ...source, kind: 'policy' as const, checkInId: null };
  const second = await prepareRemoteCoinIntrinsic({ scope, actions: [wrongRole], knownFacts: [] }, hashing);
  expect(await second.reversal(reversal, undefined)).toEqual({ status: 'invalid' });
});

it('validates correction alternatives independently and binds selected parents to exactly one proof phase', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: checkFixture.overlap.actions as HabitAction[], knownFacts: [] }, hashing);
  const ordinary = checkFixture.overlap.existingRows.filter(row => row.kind !== 'adjustment') as CoinLedgerRow[];
  const phase = await factory.proofs(ordinary);
  expect(phase.ordinaryEvidenceCount).toBe(6);
  const selected = await phase.correction(correction);
  expect(selected.status).toBe('valid');
  if (selected.status !== 'valid') throw new Error('expected correction');
  expect(await phase.correction({ ...correction, delta: -2 })).toEqual({ status: 'invalid' });
  expect((await phase.cancellation(cancellation, selected.value)).status).toBe('valid');
  expect(await phase.cancellation(cancellation, undefined)).toEqual({ status: 'pending' });
  await expect(phase.cancellation(cancellation, { ...selected.value })).rejects.toMatchObject({ reason: 'integrity' });
  const nextPhase = await factory.proofs(ordinary);
  await expect(nextPhase.cancellation(cancellation, selected.value)).rejects.toMatchObject({ reason: 'integrity' });
  const other = await phase.correction(checkFixture.overlap.existingRows[3] as CoinLedgerRow);
  if (other.status !== 'valid') throw new Error('expected second correction');
  await expect(phase.cancellation(cancellation, other.value)).rejects.toMatchObject({ reason: 'integrity' });
});

it('keeps a valid exact-E parent pending until a separately prepared expanded phase has validated it again', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts: [] }, hashing);
  const phase = await factory.proofs(rows);
  const parent = await phase.correction(correction);
  if (parent.status !== 'valid') throw new Error('expected correction');
  expect(await phase.cancellation(cancellation, parent.value)).toEqual({ status: 'pending' });
});

it('keeps an incomplete bonus proof pending without borrowing wider evidence', async () => {
  const vector = bonusFixture.reconciliationCases[0];
  const bonusScope = { kind: 'bonus', ...vector.scope } as RemoteCoinScope;
  const factory = await prepareRemoteCoinIntrinsic({ scope: bonusScope, actions: vector.actions as HabitAction[], knownFacts: [] }, hashing);
  const phase = await factory.proofs(vector.expectedAppendedRows as CoinLedgerRow[]);
  const missing = { ...correction, scopeKey: `bonus:${vector.scope.rootId}:${vector.scope.logicalDate}` };
  expect(await phase.correction(missing)).toEqual({ status: 'pending' });
});

it('rejects method-role misuse and keeps self-proof/self-cancellation dependencies invalid', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts: [] }, hashing);
  await expect(factory.award(reversal)).rejects.toMatchObject({ reason: 'integrity' });
  await expect(factory.reversal(rows[0], undefined)).rejects.toMatchObject({ reason: 'integrity' });
  const phase = await factory.proofs(rows);
  await expect(phase.correction(cancellation)).rejects.toMatchObject({ reason: 'integrity' });
  await expect(phase.cancellation(correction, undefined)).rejects.toMatchObject({ reason: 'integrity' });
  const self = { ...correction, provenanceJson: canonicalCoinProvenance([['ledger_entry', correction.id, '0'.repeat(64)]]) };
  expect(await phase.correction(self)).toEqual({ status: 'invalid' });
  expect(await phase.cancellation({ ...cancellation, adjustsId: cancellation.id }, undefined)).toEqual({ status: 'invalid' });
});

it('rejects structurally inadmissible ordinary sets and bad captured baseline identities as operation failures', async () => {
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts: [] }, hashing);
  await expect(factory.proofs([correction])).rejects.toMatchObject({ reason: 'integrity' });
  const vector = bonusFixture.reconciliationCases[0];
  const baseline = await baselineAction({ id: vector.actions[0].checkInId!, boardId: vector.scope.rootId,
    logicalDate: vector.scope.logicalDate } as Parameters<typeof baselineAction>[0], hashing);
  await expect(prepareRemoteCoinIntrinsic({ scope: { kind: 'bonus', ...vector.scope } as RemoteCoinScope,
    actions: [{ ...baseline, id: 'aaaaaaaa-0000-5000-8000-000000000001' as HabitAction['id'] }], knownFacts: [] }, hashing))
    .rejects.toMatchObject({ reason: 'integrity' });
});

it('preserves individual size failures and provider wrapper identity instead of returning a semantic verdict', async () => {
  const oversized = { ...actions[0], policyJson: ' '.repeat(COIN_POLICY_BYTES + 1) };
  await expect(prepareRemoteCoinIntrinsic({ scope, actions: [oversized], knownFacts: [] }, hashing)).rejects.toMatchObject({ reason: 'capacity' });
  const providerError = new RemoteFactHashingError(new Error('provider-owned wrapper'));
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts: [] },
    { ...hashing, sha1: async () => { throw providerError; } });
  const result = await factory.award(rows[0]).catch(error => error);
  expect(result).toBeInstanceOf(RemoteFactHashingError);
  expect(result.cause).toBe(providerError);
  const planError = await planRemoteCoinScope({ scope, actions, acceptedRows: [], candidateRows: [], knownFacts: [] },
    { ...hashing, sha1: async () => { throw providerError; } }).catch(error => error);
  expect(planError.cause).toBe(providerError);
});

it('keeps generated proof-record capacity outside invalid and pending classifications', async () => {
  const lateClear = { ...actions[0], id: 'aaaaaaaa-0000-4000-8000-000000000001' as HabitAction['id'],
    kind: 'uncheck' as const, checkInId: null, policyJson: null, createdAt: 1788926400001,
    mutationStamp: `99999999999999-zzzzz-${'a'.repeat(COIN_RECORD_BYTES - 500)}` };
  const allActions = [...actions, lateClear];
  const evidence = await prepareCoinEvidence(allActions, rows, hashing);
  const candidate = { ...correction, provenanceJson: canonicalCoinProvenance(evidence.facts.map(item => item.fingerprint)) };
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: allActions, knownFacts: [] }, hashing);
  const phase = await factory.proofs(rows);
  await expect(phase.correction(candidate)).rejects.toMatchObject({ reason: 'capacity' });
});

it('captures factory inputs and raw provider methods before awaiting and freezes the exposed context', async () => {
  const vector = bonusFixture.reconciliationCases[0];
  const bonusScope = { kind: 'bonus', ...vector.scope } as RemoteCoinScope;
  const baseline = await baselineAction({ id: 'ffffffff-0000-4000-8000-000000000001', boardId: vector.scope.rootId,
    logicalDate: vector.scope.logicalDate } as Parameters<typeof baselineAction>[0], hashing);
  const input = { scope: { ...bonusScope }, actions: [...vector.actions, baseline].map(action => ({ ...action })) as HabitAction[], knownFacts: [] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = { ...hashing, sha1: async (bytes: Uint8Array) => { await held; return hashing.sha1(bytes); } };
  const running = prepareRemoteCoinIntrinsic(input, provider);
  input.actions[0].policyJson = null; input.actions.length = 0;
  input.scope.logicalDate = '2026-09-07' as HabitAction['logicalDate'];
  provider.sha1 = async () => { throw new Error('changed method'); };
  provider.sha256 = async () => { throw new Error('changed method'); };
  release();
  const factory = await running;
  expect(Reflect.set(factory.context, 'scopeKey', 'changed')).toBe(false);
  expect(factory.context.scopeKey).toBe(`bonus:${vector.scope.rootId}:${vector.scope.logicalDate}`);
  expect((await factory.award(vector.expectedAppendedRows[0] as CoinLedgerRow)).status).toBe('valid');
});

it('snapshots award/reversal inputs independently before asynchronous hashing', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: removalVector.actions as HabitAction[], knownFacts: [] },
    { ...hashing, sha1: async bytes => { await held; return hashing.sha1(bytes); } });
  const award = { ...rows[0] }; const remove = { ...reversal };
  const checking = factory.award(award);
  const removing = factory.reversal(remove, award);
  award.createdAt += 1; award.delta = 99; remove.delta = -99;
  release();
  expect((await checking).status).toBe('valid');
  expect((await removing).status).toBe('valid');
});

it('snapshots ordinary sets, correction variants and cancellation bytes across independent awaits', async () => {
  let release!: () => void;
  let held = new Promise<void>(resolve => { release = resolve; });
  const factory = await prepareRemoteCoinIntrinsic({ scope, actions: checkFixture.overlap.actions as HabitAction[], knownFacts: [] },
    { sha1: async bytes => { await held; return hashing.sha1(bytes); }, sha256: async bytes => { await held; return hashing.sha256(bytes); } });
  const ordinary = checkFixture.overlap.existingRows.filter(row => row.kind !== 'adjustment').map(row => ({ ...row })) as CoinLedgerRow[];
  const preparing = factory.proofs(ordinary);
  ordinary[0].delta = 99; ordinary.length = 0; release();
  const phase = await preparing;
  held = new Promise<void>(resolve => { release = resolve; });
  const row = { ...correction }; const verifying = phase.correction(row);
  row.delta = -99; row.provenanceJson = '{}'; release();
  const result = await verifying;
  if (result.status !== 'valid') throw new Error('expected correction');
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(Object.isFrozen(result.value.row)).toBe(true);
  held = new Promise<void>(resolve => { release = resolve; });
  const cancel = { ...cancellation }; const cancelling = phase.cancellation(cancel, result.value);
  cancel.delta = 99; release();
  expect((await cancelling).status).toBe('valid');
  const otherFactory = await prepareRemoteCoinIntrinsic({ scope, actions: checkFixture.overlap.actions as HabitAction[], knownFacts: [] }, hashing);
  const otherPhase = await otherFactory.proofs(checkFixture.overlap.existingRows.filter(row => row.kind !== 'adjustment') as CoinLedgerRow[]);
  await expect(otherPhase.cancellation(cancellation, result.value)).rejects.toMatchObject({ reason: 'integrity' });
});

it('reuses one bonus source recovery across many same-ID variants and different partial controls', async () => {
  const vector = bonusFixture.reconciliationCases[1];
  const bonusScope = { kind: 'bonus', ...vector.scope } as RemoteCoinScope & { kind: 'bonus' };
  const sources = vector.actions as HabitAction[];
  const source = sources[1]; const base = parseCoinPolicy(source.policyJson!);
  const policies = Array.from({ length: 64 }, (_, n) => ({ ...base, bonusClosesAtUtc: base.bonusClosesAtUtc! + n }));
  const controls = policies.map((policy, n): HabitAction => ({ ...sources[0],
    id: `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as HabitAction['id'], kind: 'policy', checkInId: null,
    mutationStamp: '00000000000000-00001-fixture', policyJson: canonicalCoinPolicy(policy) }));
  const awards = await Promise.all(policies.map(policy => bonusAwardRow(bonusScope, source, policy, hashing)));
  const sha1 = jest.fn(hashing.sha1); const sha256 = jest.fn(hashing.sha256);
  const factory = await prepareRemoteCoinIntrinsic({ scope: bonusScope, actions: [...sources, ...controls], knownFacts: [] }, { sha1, sha256 });
  for (const row of awards) {
    expect((await factory.award({ ...row, createdAt: row.createdAt + 1 })).status).toBe('invalid');
    expect((await factory.award(row)).status).toBe('valid');
  }
  expect(sha1).toHaveBeenCalledTimes(64);
  expect(sha256).toHaveBeenCalledTimes(64);
});


it('classifies exact referenced foreign-board/date awards as invalid in both resolved and known-only forms', async () => {
  const removal = removalVector.actions.find(action => action.id === reversal.sourceActionId)! as HabitAction;
  const foreignBoard = 'ffffffff-0000-4000-8000-000000000001' as HabitAction['boardId'];
  const foreignDate = '2026-09-07' as HabitAction['logicalDate'];
  for (const change of [{ boardId: foreignBoard }, { logicalDate: foreignDate }]) {
    const source = { ...actions[0], id: 'ffffffff-0000-4000-8000-000000000002' as HabitAction['id'], ...change };
    const award = await checkCoinRow(source, hashing);
    const row = await checkCoinRow(removal, hashing, award);
    const resolved = await prepareRemoteCoinIntrinsic({ scope, actions: removalVector.actions as HabitAction[], knownFacts: [] }, hashing);
    expect(await resolved.reversal(row, award)).toEqual({ status: 'invalid' });
    const knownOnly = await prepareRemoteCoinIntrinsic({ scope, actions: removalVector.actions as HabitAction[], knownFacts: [fact(award)] }, hashing);
    expect(await knownOnly.reversal(row, undefined)).toEqual({ status: 'invalid' });
    await expect(resolved.reversal(row, { ...award, delta: 99 })).rejects.toMatchObject({ reason: 'integrity' });
  }
});
