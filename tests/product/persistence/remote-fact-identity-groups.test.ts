import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from '@/core/domain/ids';
import { prepareRemoteFact, restorePreparedRemoteFact, type PreparedRemoteFact } from '@/core/domain/remote-fact-validation';
import { mergeRemoteFactIdentityGroups } from '@/core/persistence/remote-fact-identity-groups';
import type { RemoteFactInboxDisposition, RemoteFactInboxVariant } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHashing } from '../helpers/test-db';

const action: HabitAction = {
  id: 'AAAAAAAA-0000-4000-8000-000000000001' as HabitActionId,
  commandId: '00000000-0000-4000-8000-000000000002' as CommandId,
  boardId: '00000000-0000-4000-8000-000000000003' as BoardId,
  checkInId: '00000000-0000-4000-8000-000000000004' as CheckInId,
  logicalDate: '2026-09-09' as LogicalDate, kind: 'check', createdAt: 0,
  mutationStamp: '00000000000000-00000-test', policyJson: null,
};
const hashing = createTestHashing();
const prepare = (value: unknown = action, factId = action.id) => prepareRemoteFact({
  factType: 'habit_action', factId, value, enqueueOnAdmission: false,
}, hashing);
function saved(prepared: PreparedRemoteFact,
  disposition: RemoteFactInboxDisposition = { state: 'pending', reason: 'dependency' }) {
  const { fact: _fact, ...fields } = prepared;
  const previous: RemoteFactInboxVariant = { ...fields, ...disposition, firstSeenAt: 10 };
  return { prepared, previous };
}
const merge = (supplied: PreparedRemoteFact[], stored: ReturnType<typeof saved>[] = [], accepted: PreparedRemoteFact[] = []) =>
  mergeRemoteFactIdentityGroups({ supplied, stored, accepted });

describe('immutable identity-group collation', () => {
  it('coalesces exact variants with restore intent and original stored metadata in every source order', async () => {
    const a = await prepare();
    const restore = { ...a, enqueueOnAdmission: true };
    const prior = saved(a);
    for (const supplied of [[a, restore], [restore, a], [a, a, restore]]) {
      const result = merge(supplied, [prior], [a]);
      expect(result).toEqual([{ identity: { factType: a.factType, factId: a.factId },
        accepted: a, variants: [{ prepared: restore, previous: prior.previous, route: 'accepted_duplicate' }] }]);
      expect(prior.previous.enqueueOnAdmission).toBe(false);
    }
    expect(merge([a], [saved(restore)])[0].variants[0].prepared.enqueueOnAdmission).toBe(true);
    expect(merge([], [prior, prior])[0].variants).toHaveLength(1);
  });

  it('preserves accepted bytes without leaking conflicting restore intent', async () => {
    const a = await prepare();
    const b = { ...await prepare({ ...action, createdAt: 1 }), enqueueOnAdmission: true };
    const result = merge([b], [], [{ ...a, enqueueOnAdmission: true }]);
    expect(result[0].accepted).toEqual(a);
    expect(result[0].variants).toEqual([{ prepared: b, previous: null, route: 'accepted_conflict' }]);
    expect(merge([], [], [a, a])[0]).toMatchObject({ accepted: a, variants: [] });
  });

  it('keeps unresolved canonical alternatives separate for later intrinsic classification', async () => {
    const a = await prepare();
    const b = await prepare({ ...action, createdAt: 1 });
    const forward = merge([a, b]);
    expect(forward).toEqual(merge([b, a]));
    expect(forward[0].accepted).toBeNull();
    expect(forward[0].variants.map(v => v.route)).toEqual(['classify', 'classify']);
    expect(forward[0].variants.map(v => v.prepared.payloadDigest)).toEqual([a.payloadDigest, b.payloadDigest].sort());
  });

  it('retains diagnostics with their separate domain even when their payload equals canonical bytes', async () => {
    const canonical = await prepare();
    const diagnostic = await prepare(JSON.parse(canonical.payload));
    expect(diagnostic.payload).toBe(canonical.payload);
    expect(diagnostic.payloadDigest).not.toBe(canonical.payloadDigest);
    const signedZero = await prepare({ ...action, createdAt: -0 });
    const restored = await restorePreparedRemoteFact(saved(signedZero, { state: 'quarantined', reason: 'invalid' }).previous, hashing);
    const result = merge([canonical, diagnostic, restored]);
    expect(result[0].variants.filter(v => v.route === 'classify')).toHaveLength(1);
    expect(result[0].variants.filter(v => v.route === 'invalid_diagnostic')).toHaveLength(2);
    expect(merge([diagnostic], [], [canonical])[0].variants[0].route).toBe('invalid_diagnostic');
  });

  it.each(['invalid', 'conflict'] as const)('retains prior canonical %s quarantine and permits accepted exact duplicate cleanup', async reason => {
    const a = await prepare();
    const prior = saved(a, { state: 'quarantined', reason });
    const b = await prepare({ ...action, createdAt: 1 });
    expect(merge([a, b], [prior])[0].variants).toContainEqual({ prepared: a, previous: prior.previous, route: 'retained_quarantine' });
    expect(merge([], [prior])[0].variants[0].route).toBe('retained_quarantine');
    expect(merge([a], [prior], [b])[0].variants[0].route).toBe('retained_quarantine');
    expect(merge([a], [prior], [a])[0].variants[0].route).toBe('accepted_duplicate');
  });

  it('aborts every same-key byte or metadata collision, including accepted duplicate cleanup', async () => {
    const a = await prepare();
    const b = { ...await prepare({ ...action, createdAt: 1 }), payloadDigest: a.payloadDigest };
    for (const run of [() => merge([a, b]), () => merge([b], [saved(a)]), () => merge([b], [], [a]),
      () => merge([], [saved(b)], [a]), () => merge([], [], [a, b])]) {
      expect(run).toThrow(expect.objectContaining({ reason: 'integrity' }));
    }
    for (const change of [{ payloadEncoding: 'rejected_json_v1' }, { payloadBytes: a.payloadBytes + 1 },
      { logicalDate: null }, { scopeKey: null }]) {
      expect(() => merge([a, { ...a, ...change } as PreparedRemoteFact]))
        .toThrow(expect.objectContaining({ reason: 'integrity' }));
    }
    expect(() => merge([], [], [a, { ...a, payloadDigest: 'f'.repeat(64), payload: 'different accepted bytes' }]))
      .toThrow(expect.objectContaining({ reason: 'integrity' }));
  });

  it('rejects contradictory recovered metadata and accepted diagnostic authority', async () => {
    const a = await prepare();
    const prior = saved(a);
    for (const change of [{ factId: action.checkInId }, { payload: 'wrong' }, { payloadDigest: '0'.repeat(64) },
      { enqueueOnAdmission: true }]) {
      expect(() => merge([], [{ prepared: a, previous: { ...prior.previous, ...change } as RemoteFactInboxVariant }]))
        .toThrow(expect.objectContaining({ reason: 'integrity' }));
    }
    for (const change of [{ firstSeenAt: 11 }, { state: 'blocked_capacity', reason: 'scope_capacity' }]) {
      expect(() => merge([], [prior, { prepared: a, previous: { ...prior.previous, ...change } as RemoteFactInboxVariant }]))
        .toThrow(expect.objectContaining({ reason: 'integrity' }));
    }
    const diagnostic = await prepare(null);
    expect(() => merge([], [], [diagnostic])).toThrow(expect.objectContaining({ reason: 'integrity' }));
  });

  it('separates binary UUID case and fact type without choosing a winner by ordering', async () => {
    const upper = await prepare();
    const lower = await prepare({ ...action, id: action.id.toLowerCase() }, action.id.toLowerCase() as HabitActionId);
    const claim = await prepareRemoteFact({ factType: 'ledger_entry', factId: action.id, enqueueOnAdmission: false, value: {
      id: action.id, kind: 'claim', delta: -1, boardId: null, checkInId: null, runKey: null,
      rewardId: action.boardId, rewardTitleSnapshot: 'Tea', reversesId: null, scopeKey: null,
      sourceActionId: null, reconciliationKey: null, adjustsId: null, provenanceJson: null,
      logicalDate: action.logicalDate, createdAt: 0, mutationStamp: action.mutationStamp, deletedAt: null,
    } }, hashing);
    expect(merge([claim, lower, upper]).map(g => g.identity)).toEqual([
      { factType: 'habit_action', factId: upper.factId }, { factType: 'habit_action', factId: lower.factId },
      { factType: 'ledger_entry', factId: claim.factId },
    ]);
  });

  it('owns returned metadata and fact values across subsequent caller mutation', async () => {
    const a = await prepare();
    const prior = saved(a);
    const result = merge([a], [prior], [a]);
    const before = JSON.parse(JSON.stringify(result));
    a.fact!.value.createdAt = 99;
    a.payload = 'changed';
    prior.previous.firstSeenAt = 99;
    expect(result).toEqual(before);
    expect(merge([])).toEqual([]);
  });
});
