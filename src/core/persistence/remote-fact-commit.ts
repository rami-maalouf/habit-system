import { RemoteFactAdmissionError, type CanonicalRemoteFact, type RemoteFactIdentity } from '../domain/remote-fact-validation';
import type { SqlExecutor } from './database';
import { appendHabitAction } from './repositories/habit-actions';
import { appendLedgerEntry } from './repositories/ledger';
import { applyRemoteFactInboxChanges } from './repositories/remote-fact-inbox';
import { appendOutbox } from './repositories/support';

export type RemoteFactOutboxEntry = RemoteFactIdentity & { mutationStamp: string };
export type RemoteFactCommitPlan = {
  // only complete, resolved new identities belong here; existing duplicates are not insertions.
  insertions: readonly CanonicalRemoteFact[];
  enqueue: readonly RemoteFactOutboxEntry[];
  inbox: Parameters<typeof applyRemoteFactInboxChanges>[1];
};
const tuple = ({ factType, factId, mutationStamp }: RemoteFactOutboxEntry) => [factType, factId, mutationStamp];
const tupleKey = (entry: RemoteFactOutboxEntry) => JSON.stringify(tuple(entry));

// the caller owns planning and the transaction through projections, hlc and its final marker.
export async function commitRemoteFacts(tx: SqlExecutor, plan: RemoteFactCommitPlan, acquiredNow: number,
  checkpoint: () => void = () => {}) {
  if (!Number.isSafeInteger(acquiredNow) || acquiredNow < 0 || Object.is(acquiredNow, -0)) {
    throw new RemoteFactAdmissionError('envelope');
  }
  const insertions = plan.insertions.map(fact => ({ ...fact, value: { ...fact.value } }) as CanonicalRemoteFact);
  const wanted = new Map(plan.enqueue.map(entry => {
    const owned = { factType: entry.factType, factId: entry.factId, mutationStamp: entry.mutationStamp };
    return [tupleKey(owned), owned];
  }));
  const inbox = {
    removals: plan.inbox.removals.map(key => ({ ...key })),
    upserts: plan.inbox.upserts.map(({ prepared, disposition }) => ({
      prepared: { ...prepared, fact: null }, disposition: { ...disposition },
    })),
  };
  checkpoint();
  let localChanged = false;
  for (const fact of insertions) {
    const inserted = fact.factType === 'habit_action'
      ? await appendHabitAction(tx, fact.value) : await appendLedgerEntry(tx, fact.value);
    if (!inserted) throw new RemoteFactAdmissionError('integrity');
    localChanged = true;
    checkpoint();
  }
  if (wanted.size) {
    const existing = await tx.getAllAsync<RemoteFactOutboxEntry>(`SELECT DISTINCT entity_type AS factType,
      entity_id AS factId, mutation_stamp AS mutationStamp FROM mutation_outbox
      WHERE (entity_type, entity_id, mutation_stamp) IN
        (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))`,
    [JSON.stringify([...wanted.values()].map(tuple))]);
    checkpoint();
    for (const entry of existing) wanted.delete(tupleKey(entry));
    for (const entry of wanted.values()) {
      await appendOutbox(tx, entry.factType, entry.factId, entry.mutationStamp, acquiredNow);
      localChanged = true;
      checkpoint();
    }
  }
  checkpoint();
  const result = await applyRemoteFactInboxChanges(tx, inbox, acquiredNow);
  checkpoint();
  return { counts: result.counts, localChanged: localChanged || result.localChanged };
}
