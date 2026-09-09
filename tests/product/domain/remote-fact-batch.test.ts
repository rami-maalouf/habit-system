import type { HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LogicalDate } from '@/core/domain/ids';
import { CoinContractError } from '@/core/domain/coin-policy';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { prepareRemoteFact, prepareRemoteFacts, type RemoteFactCandidate } from '@/core/domain/remote-fact-validation';

import { createTestHashing } from '../helpers/test-db';

const action: HabitAction = {
  id: 'AAAAAAAA-0000-4000-8000-000000000001' as HabitActionId,
  boardId: '00000000-0000-4000-8000-000000000002' as BoardId,
  commandId: '00000000-0000-4000-8000-000000000003' as CommandId,
  checkInId: '00000000-0000-4000-8000-000000000004' as CheckInId,
  logicalDate: '2026-09-09' as LogicalDate, kind: 'check', createdAt: 0,
  mutationStamp: '00000000000000-00000-test', policyJson: null,
};
const hashing = createTestHashing();
const candidate = (value: unknown = action): RemoteFactCandidate => ({
  factType: 'habit_action', factId: action.id, enqueueOnAdmission: false, value,
});

describe('complete remote candidate batch preparation', () => {
  it('captures later records, identities, intent and signed zero before the first hash completes', async () => {
    const secondBody = { ...action, createdAt: 1 };
    const signedZeroBody = { ...action, createdAt: -0 };
    const candidates = [candidate(), candidate(secondBody), candidate(signedZeroBody)];
    candidates[1].enqueueOnAdmission = true;
    const expected = await Promise.all(candidates.map(input => prepareRemoteFact(input, hashing)));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const port = { ...hashing, sha256: async (bytes: Uint8Array) => {
      await held; return hashing.sha256(bytes);
    } };
    const result = prepareRemoteFacts(candidates, port);
    Object.assign(candidates[1], { factId: 'changed', enqueueOnAdmission: false, value: null });
    secondBody.createdAt = 99;
    signedZeroBody.createdAt = 0;
    candidates.reverse();
    candidates.push(candidate(null));
    port.sha256 = async () => { throw new Error('replacement must not be used'); };
    release();
    expect(await result).toEqual(expected);
    expect(expected[2]).toMatchObject({ fact: null, payloadEncoding: 'rejected_json_v1' });
  });

  it('runs at most one provider request at a time while retaining input order', async () => {
    let active = 0;
    let maximum = 0;
    const port = { ...hashing, sha256: async (bytes: Uint8Array) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      const digest = await hashing.sha256(bytes);
      active -= 1;
      return digest;
    } };
    const values = Array.from({ length: 200 }, (_, createdAt) => candidate({ ...action, createdAt }));
    const result = await prepareRemoteFacts(values, port);
    expect(result.map(item => item.fact?.value.createdAt)).toEqual(values.map((_, index) => index));
    expect(maximum).toBe(1);
    expect(await prepareRemoteFacts([], port)).toEqual([]);
  });

  it('rejects a later malformed envelope before invoking any hash provider', async () => {
    let calls = 0;
    const port = { ...hashing, sha256: async (bytes: Uint8Array) => {
      calls += 1; return hashing.sha256(bytes);
    } };
    await expect(prepareRemoteFacts([candidate(), { ...candidate(), factId: 'bad' }], port))
      .rejects.toMatchObject({ reason: 'envelope' });
    expect(calls).toBe(0);
    await expect(prepareRemoteFacts(null as never, port)).rejects.toMatchObject({ reason: 'envelope' });
  });

  it('keeps provider failures in one owned guard layer without returning a partial batch', async () => {
    const original = new RemoteFactHashingError(new CoinContractError('invalid'));
    let calls = 0;
    const result = prepareRemoteFacts([candidate(), candidate({ ...action, createdAt: 1 })], {
      ...hashing, sha256: async bytes => {
        if (++calls === 2) throw original;
        return hashing.sha256(bytes);
      },
    });
    await expect(result).rejects.toMatchObject({ name: 'RemoteFactHashingError', cause: original });
    try { await result; } catch (failure) {
      expect((failure as RemoteFactHashingError).cause).toBe(original);
    }
    expect(calls).toBe(2);
  });
});
