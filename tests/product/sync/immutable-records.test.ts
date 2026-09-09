import checkFixture from '@/core/automations/fixtures/check-coins.json';
import type { HabitAction } from '@/core/domain/habit-actions';
import type { CoinLedgerRow } from '@/core/domain/coin-ledger';
import { prepareRemoteFacts, RemoteFactAdmissionError } from '@/core/domain/remote-fact-validation';
import { immutableSyncCandidate } from '@/core/sync/immutable-records';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const source = checkFixture.cases[0].actions[0] as HabitAction;
const award = checkFixture.cases[0].ordinaryRows[0] as CoinLedgerRow;
const action = () => ({ schemaVersion: 2, entityType: 'habit_action', entityId: source.id,
  mutationStamp: source.mutationStamp, deleted: false, fields: {
    id: source.id, command_id: source.commandId, board_id: source.boardId,
    logical_date: source.logicalDate, check_in_id: source.checkInId, kind: source.kind,
    created_at: source.createdAt, policy_json: source.policyJson,
  } });
const ledger = () => ({ schemaVersion: 2, entityType: 'ledger_entry', entityId: award.id,
  mutationStamp: award.mutationStamp, deleted: false, fields: {
    id: award.id, kind: award.kind, delta: award.delta, board_id: award.boardId,
    check_in_id: award.checkInId, run_key: award.runKey, reward_id: award.rewardId,
    reward_title_snapshot: award.rewardTitleSnapshot, reverses_id: award.reversesId,
    scope_key: award.scopeKey, source_action_id: award.sourceActionId,
    reconciliation_key: award.reconciliationKey, adjusts_id: award.adjustsId,
    provenance_json: award.provenanceJson, logical_date: award.logicalDate,
    created_at: award.createdAt, deleted_at: award.deletedAt,
  } });

describe('immutable schema-2 wire candidates', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });
  const prepare = (wire: unknown) => prepareRemoteFacts([immutableSyncCandidate(wire)], h.deps.hashing);

  it('reconstructs original source and award bytes without observing a clock or adding restore intent', async () => {
    for (const [wire, value] of [[action(), source], [ledger(), award]] as const) {
      const candidate = immutableSyncCandidate(wire);
      expect(candidate).toEqual({ factType: wire.entityType, factId: wire.entityId,
        value, enqueueOnAdmission: false });
      expect((await prepare(wire))[0]).toMatchObject({ fact: { factType: wire.entityType, value },
        payloadEncoding: 'canonical_v1', enqueueOnAdmission: false });
    }
  });

  it.each(['id', 'command_id', 'policy_json'])('retains the entire rejected wire when action field %s is absent', async field => {
    const wire = action();
    delete (wire.fields as Record<string, unknown>)[field];
    const prepared = (await prepare(wire))[0];
    expect(prepared.fact).toBeNull();
    expect(prepared.payloadEncoding).toBe('rejected_json_v1');
    expect(JSON.parse(prepared.payload)).toEqual(wire);
  });

  it.each(['id', 'reward_title_snapshot', 'deleted_at'])('retains the entire rejected wire when ledger field %s is absent', async field => {
    const wire = ledger();
    delete (wire.fields as Record<string, unknown>)[field];
    expect((await prepare(wire))[0]).toMatchObject({ fact: null,
      payloadEncoding: 'rejected_json_v1', payload: JSON.stringify(wire) });
  });

  it.each([action, ledger])('does not discard extra metadata or tombstone flags to create an admissible fact', async build => {
    const wire = build();
    for (const invalid of [{ ...wire, deleted: true },
      { ...wire, fields: { ...wire.fields, device_id: 'unexpected' } },
      { ...wire, fields: { ...wire.fields, unexpected: null } }]) {
      expect((await prepare(invalid))[0]).toMatchObject({ fact: null,
        payloadEncoding: 'rejected_json_v1', payload: JSON.stringify(invalid) });
    }
  });

  it('passes inner id and stamp defects unchanged into diagnostic validation', async () => {
    const original = action();
    const badId = { ...original, fields: { ...original.fields, id: award.id } };
    expect((await prepare(badId))[0]).toMatchObject({ factId: source.id, fact: null });
    for (const mutationStamp of ['', 'not-a-stamp', '99999999999999-100000-peer']) {
      const candidate = immutableSyncCandidate({ ...action(), mutationStamp });
      expect(candidate.value).toMatchObject({ mutationStamp });
      expect((await prepareRemoteFacts([candidate], h.deps.hashing))[0].fact).toBeNull();
    }
  });

  it('preserves signed zero until the admission snapshot permanently marks it rejected', async () => {
    for (const build of [action, ledger]) {
      const wire = build();
      wire.fields.created_at = -0;
      const candidate = immutableSyncCandidate(wire);
      expect(Object.is((candidate.value as { createdAt: number }).createdAt, -0)).toBe(true);
      expect((await prepareRemoteFacts([candidate], h.deps.hashing))[0]).toMatchObject({
        fact: null, payloadEncoding: 'rejected_json_v1',
      });
    }
  });

  it('captures supplied scalar fields before later caller mutation, including rejected bodies', async () => {
    const valid = action();
    const invalid = { ...ledger(), deleted: true };
    const a = immutableSyncCandidate(valid);
    const b = immutableSyncCandidate(invalid);
    const snapshot = JSON.stringify(invalid);
    valid.fields.policy_json = null;
    valid.mutationStamp = 'changed';
    invalid.fields.delta = 999;
    invalid.deleted = false;
    expect(a.value).toEqual(source);
    expect((await prepareRemoteFacts([b], h.deps.hashing))[0].payload).toBe(snapshot);
  });

  it.each([null, [], {}, { ...action(), schemaVersion: 1 }, { ...ledger(), schemaVersion: 3 },
    { ...action(), entityType: 'board' }, { ...action(), entityId: 'bad' },
    { ...action(), entityId: 1 }, { ...action(), deleted: 0 },
    { ...action(), mutationStamp: null }, { ...action(), fields: [] },
    { ...action(), fields: null }, { ...action(), fields: { bad: Infinity } },
    { ...action(), fields: { bad: undefined } }, { ...action(), fields: { bad: true } },
    { ...action(), fields: { bad: {} } }, { ...action(), unexpected: 1 },
  ])('rejects untrusted or unretainable envelopes before admission: %j', wire => {
    expect(() => immutableSyncCandidate(wire)).toThrow(RemoteFactAdmissionError);
  });
});
