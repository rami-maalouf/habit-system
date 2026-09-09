import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalCoinLedger, type CoinLedgerRow } from '@/core/domain/coin-ledger';
import * as ledger from '@/core/domain/coin-ledger';
import { CoinContractError } from '@/core/domain/coin-policy';
import { baselineAction, canonicalHabitAction, type HabitAction } from '@/core/domain/habit-actions';
import type { BoardId, CheckInId, CommandId, HabitActionId, LedgerEntryId, LogicalDate, RewardId } from '@/core/domain/ids';
import { RemoteFactHashingError } from '@/core/domain/remote-fact-hashing';
import { prepareRemoteFact, restorePreparedRemoteFact, type PreparedRemoteFact } from '@/core/domain/remote-fact-validation';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import { applyRemoteFactInboxChanges, readRemoteFactInbox } from '@/core/persistence/repositories/remote-fact-inbox';

import { createTestHashing, NodeSqlDatabase, TestIds } from '../helpers/test-db';

const boardId = 'AAAAAAAA-0000-4000-8000-000000000001' as BoardId;
const date = '2026-09-09' as LogicalDate;
const action: HabitAction = {
  id: 'BBBBBBBB-0000-4000-8000-000000000002' as HabitActionId,
  commandId: '00000000-0000-4000-8000-000000000003' as CommandId,
  boardId, logicalDate: date, checkInId: '00000000-0000-4000-8000-000000000004' as CheckInId,
  kind: 'check', createdAt: 0, mutationStamp: '00000000000000-00000-test', policyJson: null,
};
const claim: CoinLedgerRow = {
  id: 'CCCCCCCC-0000-4000-8000-000000000005' as LedgerEntryId,
  kind: 'claim', delta: -5, boardId: null, checkInId: null, runKey: null,
  rewardId: '00000000-0000-4000-8000-000000000006' as RewardId,
  rewardTitleSnapshot: 'Café', reversesId: null, scopeKey: null, sourceActionId: null,
  reconciliationKey: null, adjustsId: null, provenanceJson: null, logicalDate: date,
  createdAt: 0, mutationStamp: action.mutationStamp, deletedAt: null,
};
const hashing = createTestHashing();
type Stored = Omit<PreparedRemoteFact, 'fact'>;
const stored = ({ fact: _fact, ...rest }: PreparedRemoteFact): Stored => rest;
const preparedAction = () => prepareRemoteFact({ factType: 'habit_action', factId: action.id,
  value: action, enqueueOnAdmission: true }, hashing);
function replacePayload(input: Stored, payload: string): Stored {
  const digestInput = input.payloadEncoding === 'canonical_v1' ? payload
    : JSON.stringify(['habit-remote-rejected-json-v1', input.factType, input.factId, payload]);
  return { ...input, payload, payloadBytes: Buffer.byteLength(payload),
    payloadDigest: createHash('sha256').update(digestInput).digest('hex') };
}

describe('persisted remote fact recovery', () => {
  it('round-trips exact canonical actions, claims and authorized baseline identities', async () => {
    const baseline = await baselineAction({ id: action.checkInId!, boardId, logicalDate: date }, hashing);
    const values = [await preparedAction(),
      await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id, value: claim, enqueueOnAdmission: false }, hashing),
      await prepareRemoteFact({ factType: 'habit_action', factId: baseline.id, value: baseline, enqueueOnAdmission: false }, hashing)];
    for (const prepared of values) {
      const result = await restorePreparedRemoteFact(stored(prepared), hashing);
      expect(result).toEqual(prepared);
      expect(result.fact?.value).not.toBe(prepared.fact?.value);
    }
  });

  it('keeps rejected signed-zero diagnostics rejected after JSON loses the sign', async () => {
    const prepared = await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
      value: { ...claim, createdAt: -0 }, enqueueOnAdmission: true }, hashing);
    expect(prepared.payload).toBe(JSON.stringify(claim));
    expect(prepared.fact).toBeNull();
    expect(await restorePreparedRemoteFact(stored(prepared), hashing)).toEqual(prepared);
  });

  it('retains invalid, null and primitive diagnostics without attempting economic validation', async () => {
    for (const value of [null, 'retained diagnostic', { ...action, extra: true }]) {
      const prepared = await prepareRemoteFact({ factType: 'habit_action', factId: action.id,
        value, enqueueOnAdmission: false }, hashing);
      expect(await restorePreparedRemoteFact(stored(prepared), hashing)).toEqual(prepared);
    }
  });

  it('rejects corrupt stored metadata before allowing any restored fact', async () => {
    const valid = stored(await preparedAction());
    for (const change of [{ factType: 'check_in' }, { factId: 'invalid' }, { enqueueOnAdmission: 1 },
      { payloadEncoding: 'json' }, { payload: null }, { payloadDigest: 'A'.repeat(64) },
      { payloadBytes: -1 }, { payloadBytes: -0 }, { payloadBytes: valid.payloadBytes + 1 },
      { logicalDate: '2026-09-10' }, { scopeKey: null }, { factId: claim.id },
      { payloadDigest: '0'.repeat(64) }]) {
      await expect(restorePreparedRemoteFact({ ...valid, ...change } as Stored, hashing))
        .rejects.toMatchObject({ reason: 'integrity' });
    }
    await expect(restorePreparedRemoteFact(null as never, hashing)).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('rejects noncanonical, malformed or wrong-role tuple bytes even with matching digests', async () => {
    const valid = stored(await preparedAction());
    for (const payload of ['[', 'null', '{}', JSON.stringify(action), ' ' + valid.payload,
      JSON.stringify([...JSON.parse(valid.payload), 'extra']),
      canonicalHabitAction({ ...action, commandId: null }),
      canonicalHabitAction({ ...action, id: claim.id as unknown as HabitActionId }),
      canonicalCoinLedger(claim), valid.payload.replace(',0,', ',-0,')]) {
      await expect(restorePreparedRemoteFact(replacePayload(valid, payload), hashing))
        .rejects.toMatchObject({ reason: 'integrity' });
    }
    const ledger = stored(await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
      value: claim, enqueueOnAdmission: false }, hashing));
    for (const payload of [ledger.payload.replace('habit-ledger-row-v1', 'habit-ledger-row-v2'),
      canonicalCoinLedger({ ...claim, delta: 1 }), JSON.stringify(JSON.parse(ledger.payload).slice(1))]) {
      await expect(restorePreparedRemoteFact(replacePayload(ledger, payload), hashing))
        .rejects.toMatchObject({ reason: 'integrity' });
    }
  });

  it('detects baseline identity corruption rather than granting legacy authority', async () => {
    const baseline = await baselineAction({ id: action.checkInId!, boardId, logicalDate: date }, hashing);
    const prepared = stored(await prepareRemoteFact({ factType: 'habit_action', factId: baseline.id,
      value: baseline, enqueueOnAdmission: false }, hashing));
    const wrongId = '00000000-0000-5000-8000-000000000099' as HabitActionId;
    const corrupt = replacePayload({ ...prepared, factId: wrongId }, canonicalHabitAction({ ...baseline, id: wrongId }));
    await expect(restorePreparedRemoteFact(corrupt, hashing)).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('verifies diagnostic compact bytes, domain digest, and selectors without reclassification', async () => {
    const valid = stored(await prepareRemoteFact({ factType: 'habit_action', factId: action.id,
      value: { ...action, extra: true }, enqueueOnAdmission: false }, hashing));
    for (const payload of [' ' + valid.payload, '[', '1e999', '-0']) {
      await expect(restorePreparedRemoteFact(replacePayload(valid, payload), hashing))
        .rejects.toMatchObject({ reason: 'integrity' });
    }
    await expect(restorePreparedRemoteFact({ ...valid,
      payloadDigest: createHash('sha256').update(valid.payload).digest('hex') }, hashing))
      .rejects.toMatchObject({ reason: 'integrity' });
  });

  it('enforces persisted record and nested policy limits as integrity failures', async () => {
    const valid = stored(await preparedAction());
    const bounded = { ...action, mutationStamp: action.mutationStamp + 'x'.repeat(786432 - Buffer.byteLength(valid.payload)) };
    const exact = replacePayload(valid, canonicalHabitAction(bounded));
    expect((await restorePreparedRemoteFact(exact, hashing)).payloadBytes).toBe(786432);
    for (const payload of [canonicalHabitAction({ ...bounded, mutationStamp: bounded.mutationStamp + 'x' }),
      canonicalHabitAction({ ...action, policyJson: ' '.repeat(196609) })]) {
      await expect(restorePreparedRemoteFact(replacePayload(valid, payload), hashing))
        .rejects.toMatchObject({ reason: 'integrity' });
    }
  });

  it('captures stored bytes and all metadata before the first hash await', async () => {
    const original = await preparedAction();
    const input = stored(original);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const result = restorePreparedRemoteFact(input, { ...hashing, sha256: async bytes => {
      await wait; return hashing.sha256(bytes);
    } });
    Object.assign(input, { factType: 'ledger_entry', factId: claim.id, payload: 'null', payloadBytes: 4,
      payloadDigest: '0'.repeat(64), enqueueOnAdmission: false, logicalDate: null, scopeKey: null });
    release();
    expect(await result).toEqual(original);
  });

  it('keeps crypto failures outside stored corruption and candidate verdicts', async () => {
    const valid = stored(await preparedAction());
    for (const cause of [new CoinContractError('invalid'), new CoinContractError('size'), new Error('cancelled')]) {
      await expect(restorePreparedRemoteFact(valid, { ...hashing, sha256: async () => { throw cause; } }))
        .rejects.toMatchObject({ name: 'RemoteFactHashingError', cause });
    }
    await expect(restorePreparedRemoteFact(valid, { ...hashing, sha256: async () => new Uint8Array(31) }))
      .rejects.toBeInstanceOf(RemoteFactHashingError);
    const baseline = await baselineAction({ id: action.checkInId!, boardId, logicalDate: date }, hashing);
    const prepared = stored(await prepareRemoteFact({ factType: 'habit_action', factId: baseline.id,
      value: baseline, enqueueOnAdmission: false }, hashing));
    const cause = new CoinContractError('missing');
    await expect(restorePreparedRemoteFact(prepared, { ...hashing, sha1: async () => { throw cause; } }))
      .rejects.toMatchObject({ name: 'RemoteFactHashingError', cause });
  });

  it('propagates an unexpected validator failure instead of reporting corrupt storage', async () => {
    const valid = stored(await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
      value: claim, enqueueOnAdmission: false }, hashing));
    const failure = new Error('validator dependency failed');
    const spy = jest.spyOn(ledger, 'assertCoinLedgerShape').mockImplementation(() => { throw failure; });
    try { await expect(restorePreparedRemoteFact(valid, hashing)).rejects.toBe(failure); }
    finally { spy.mockRestore(); }
  });

  it('recovers exact retryable facts and rejected diagnostics after a real database restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'habit-inbox-codec-'));
    const path = join(directory, 'db.sqlite');
    let db = new NodeSqlDatabase(path);
    try {
      expect((await initializeProductDatabase(db, new TestIds(), hashing)).ok).toBe(true);
      const canonical = await preparedAction();
      const rejected = await prepareRemoteFact({ factType: 'ledger_entry', factId: claim.id,
        value: { ...claim, createdAt: -0 }, enqueueOnAdmission: true }, hashing);
      await db.withExclusiveTransactionAsync(tx => applyRemoteFactInboxChanges(tx, { removals: [], upserts: [
        { prepared: canonical, disposition: { state: 'pending', reason: 'dependency' } },
        { prepared: rejected, disposition: { state: 'quarantined', reason: 'invalid' } },
      ] }, 123));
      await db.closeAsync();
      db = new NodeSqlDatabase(path);
      const rows = await readRemoteFactInbox(db, [canonical, rejected]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ firstSeenAt: 123, enqueueOnAdmission: true });
        expect(await restorePreparedRemoteFact(row, hashing))
          .toEqual(row.factType === 'habit_action' ? canonical : rejected);
      }
      expect(await db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
      expect(await db.getAllAsync('SELECT * FROM coin_ledger')).toEqual([]);
    } finally { await db.closeAsync(); rmSync(directory, { recursive: true, force: true }); }
  });
});
