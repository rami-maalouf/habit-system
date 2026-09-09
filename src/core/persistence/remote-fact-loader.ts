import { isValidLogicalDate } from '../calendar/logical-date';
import { canonicalCoinLedger } from '../domain/coin-ledger';
import { canonicalHabitAction } from '../domain/habit-actions';
import { isUuidV4, isUuidV5 } from '../domain/ids';
import type { Hashing } from '../domain/ports';
import { guardRemoteFactHashing, RemoteFactHashingError } from '../domain/remote-fact-hashing';
import { prepareRemoteFact, restorePreparedRemoteFact, RemoteFactAdmissionError,
  type CanonicalRemoteFact, type PreparedRemoteFact, type RemoteFactIdentity } from '../domain/remote-fact-validation';
import type { SqlExecutor } from './database';
import { mergeRemoteFactIdentityGroups, type RecoveredRemoteFact, type RemoteFactIdentityGroup } from './remote-fact-identity-groups';
import { readRemoteFactEvidencePage, readRemoteFactsById,
  type RemoteCheckScope, type RemoteRootScope } from './repositories/remote-fact-evidence';
import { readRemoteFactInbox, type RemoteFactInboxVariant } from './repositories/remote-fact-inbox';

export type RemoteFactLoaderNeeds = {
  identities?: readonly RemoteFactIdentity[];
  checkScopes?: readonly RemoteCheckScope[];
  rootScopes?: readonly RemoteRootScope[];
  reverseScopes?: readonly RemoteCheckScope[];
};
export type RemoteFactLoaderDelta = {
  // each identity is complete, including accepted absence and every stored variant.
  groups: RemoteFactIdentityGroup[];
  completed: { checkScopes: RemoteCheckScope[]; rootScopes: RemoteRootScope[]; reverseScopes: RemoteCheckScope[] };
};

const key = ({ factType, factId }: RemoteFactIdentity) => JSON.stringify([factType, factId]);
const factIdentity = (fact: CanonicalRemoteFact): RemoteFactIdentity => ({ factType: fact.factType, factId: fact.value.id });
const canonical = (fact: CanonicalRemoteFact) => fact.factType === 'habit_action'
  ? canonicalHabitAction(fact.value) : canonicalCoinLedger(fact.value);
const unique = <T>(values: readonly T[], identify: (value: T) => string): T[] =>
  [...new Map(values.map(value => [identify(value), value])).entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([, value]) => value);
const checkKey = ({ boardId, logicalDate }: RemoteCheckScope) => JSON.stringify([boardId, logicalDate]);
const rootKey = ({ rootId, logicalDate }: RemoteRootScope) => JSON.stringify([rootId, logicalDate]);

function snapshotNeeds(input: RemoteFactLoaderNeeds) {
  const identities = (input.identities ?? []).map(({ factType, factId }) => {
    if (!['habit_action', 'ledger_entry'].includes(factType) || typeof factId !== 'string' ||
      !(isUuidV4(factId) || isUuidV5(factId))) throw new RemoteFactAdmissionError('envelope');
    return { factType, factId };
  });
  function validPair(id: string, logicalDate: string) {
    if (typeof id !== 'string' || !isUuidV4(id) || typeof logicalDate !== 'string' || !isValidLogicalDate(logicalDate)) {
      throw new RemoteFactAdmissionError('envelope');
    }
  }
  const checks = (pairs: readonly RemoteCheckScope[]) => unique(pairs.map(({ boardId, logicalDate }) => {
    validPair(boardId, logicalDate); return { boardId, logicalDate };
  }), checkKey);
  const rootScopes = unique((input.rootScopes ?? []).map(({ rootId, logicalDate }) => {
    validPair(rootId, logicalDate); return { rootId, logicalDate };
  }), rootKey);
  return { identities: unique(identities, key), checkScopes: checks(input.checkScopes ?? []),
    rootScopes, reverseScopes: checks(input.reverseScopes ?? []) };
}

// one unchanged caller-owned transaction; failures require a fresh transaction and loader.
export async function createRemoteFactLoader({ tx, sourceHashing }: { tx: SqlExecutor; sourceHashing: Hashing },
  supplied: readonly PreparedRemoteFact[]) {
  const suppliedGroups = new Map(mergeRemoteFactIdentityGroups({ supplied, stored: [], accepted: [] })
    .map(group => [key(group.identity), group]));
  let raw: Hashing;
  try { raw = { sha1: sourceHashing.sha1.bind(sourceHashing), sha256: sourceHashing.sha256.bind(sourceHashing) }; }
  catch (cause) { throw new RemoteFactHashingError(cause); }
  const hashing = guardRemoteFactHashing(raw);
  const accepted = new Map<string, PreparedRemoteFact>();
  const absent = new Set<string>();
  const complete = new Set<string>();
  const restored = new Map<string, { signature: string; recovered: RecoveredRemoteFact }>();
  const completed = { checkScopes: new Set<string>(), rootScopes: new Set<string>(), reverseScopes: new Set<string>() };

  async function restore(input: RemoteFactInboxVariant) {
    const previous = { ...input };
    const variantKey = JSON.stringify([previous.factType, previous.factId, previous.payloadDigest]);
    const signature = JSON.stringify([previous.payloadEncoding, previous.payload, previous.payloadBytes,
      previous.logicalDate, previous.scopeKey, previous.enqueueOnAdmission, previous.state, previous.reason, previous.firstSeenAt]);
    const cached = restored.get(variantKey);
    if (cached) {
      if (cached.signature !== signature) throw new RemoteFactAdmissionError('integrity');
      return cached.recovered;
    }
    const recovered = { previous, prepared: await restorePreparedRemoteFact(previous, raw) };
    restored.set(variantKey, { signature, recovered });
    return recovered;
  }

  async function accept(input: CanonicalRemoteFact) {
    const fact = { ...input, value: { ...input.value } } as CanonicalRemoteFact;
    const identity = factIdentity(fact); const identityKey = key(identity);
    const cached = accepted.get(identityKey);
    if (cached) {
      if (cached.payload !== canonical(fact)) throw new RemoteFactAdmissionError('integrity');
      return;
    }
    if (absent.has(identityKey)) throw new RemoteFactAdmissionError('integrity');
    const prepared = await prepareRemoteFact({ ...identity, value: fact.value, enqueueOnAdmission: false }, hashing);
    if (prepared.fact === null) throw new RemoteFactAdmissionError('integrity');
    accepted.set(identityKey, prepared);
  }

  async function completeGroups(input: readonly RemoteFactIdentity[]) {
    const identities = unique(input, key).filter(identity => !complete.has(key(identity)));
    const groups: RemoteFactIdentityGroup[] = [];
    for (let offset = 0; offset < identities.length; offset += 64) {
      const batch = identities.slice(offset, offset + 64);
      const lookup = batch.filter(identity => !accepted.has(key(identity)));
      const found = await readRemoteFactsById(tx, lookup);
      for (const fact of found.facts) await accept(fact);
      for (const identity of found.missing) absent.add(key(identity));
      const stored = new Map<string, RecoveredRemoteFact[]>();
      for (const row of await readRemoteFactInbox(tx, batch)) {
        const identityKey = key(row); const values = stored.get(identityKey) ?? [];
        values.push(await restore(row)); stored.set(identityKey, values);
      }
      for (const identity of batch) {
        const identityKey = key(identity); const saved = accepted.get(identityKey);
        const merged = mergeRemoteFactIdentityGroups({ supplied: suppliedGroups.get(identityKey)?.variants.map(v => v.prepared) ?? [],
          stored: stored.get(identityKey) ?? [], accepted: saved ? [saved] : [] });
        groups.push(merged[0] ?? { identity, accepted: null, variants: [] });
        complete.add(identityKey);
      }
    }
    return groups;
  }

  async function load(input: ReturnType<typeof snapshotNeeds>): Promise<RemoteFactLoaderDelta> {
    const selection = {
      checkScopes: input.checkScopes.filter(pair => !completed.checkScopes.has(checkKey(pair))),
      rootScopes: input.rootScopes.filter(pair => !completed.rootScopes.has(rootKey(pair))),
      reverseScopes: input.reverseScopes.filter(pair => !completed.reverseScopes.has(checkKey(pair))),
    };
    const identities = [...input.identities];
    if (selection.checkScopes.length || selection.rootScopes.length || selection.reverseScopes.length) {
      let after: RemoteFactIdentity | undefined;
      do {
        const page = await readRemoteFactEvidencePage(tx, { ...selection, after, limit: 64 });
        for (const fact of page.facts) { await accept(fact); identities.push(factIdentity(fact)); }
        after = page.nextCursor ?? undefined;
      } while (after !== undefined);
    }
    const groups = await completeGroups(identities);
    for (const pair of selection.checkScopes) completed.checkScopes.add(checkKey(pair));
    for (const pair of selection.rootScopes) completed.rootScopes.add(rootKey(pair));
    for (const pair of selection.reverseScopes) completed.reverseScopes.add(checkKey(pair));
    return { groups, completed: selection };
  }

  const retry = await readRemoteFactInbox(tx);
  for (const row of retry) await restore(row);
  const initial = await load(snapshotNeeds({ identities: [...suppliedGroups.values()].map(group => group.identity).concat(retry) }));
  let queue = Promise.resolve();
  let failed = false; let failure: unknown;
  function enqueue(run: () => Promise<RemoteFactLoaderDelta>) {
    const work = queue.then(() => {
      if (failed) throw failure;
      return run();
    });
    queue = work.then(() => undefined, cause => { failed = true; failure = cause; });
    return work;
  }
  return { initial, extend(needs: RemoteFactLoaderNeeds): Promise<RemoteFactLoaderDelta> {
    try {
      const owned = snapshotNeeds(needs);
      return enqueue(() => load(owned));
    } catch (cause) { return enqueue(async () => { throw cause; }); }
  } };
}
