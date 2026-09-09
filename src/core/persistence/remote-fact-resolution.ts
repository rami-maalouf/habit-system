import { canonicalCoinLedger, type CoinLedgerRow } from '../domain/coin-ledger';
import { parseCoinPolicy } from '../domain/coin-policy';
import { parseCoinProvenance } from '../domain/coin-provenance';
import type { ValidatedCoinCorrection } from '../domain/coin-reconciliation-core';
import type { HabitAction } from '../domain/habit-actions';
import type { BoardId, LogicalDate } from '../domain/ids';
import type { Hashing } from '../domain/ports';
import { guardRemoteFactHashing } from '../domain/remote-fact-hashing';
import { prepareRemoteCoinIntrinsic } from '../domain/remote-fact-intrinsic';
import { planRemoteCoinScope, type RemoteCoinScope } from '../domain/remote-fact-scope-plan';
import { prepareRemoteFact, RemoteFactAdmissionError, type PreparedRemoteFact, type RemoteFactIdentity } from '../domain/remote-fact-validation';
import type { RemoteFactCommitPlan } from './remote-fact-commit';
import type { RemoteFactIdentityGroup } from './remote-fact-identity-groups';
import type { createRemoteFactLoader, RemoteFactLoaderDelta, RemoteFactLoaderNeeds } from './remote-fact-loader';
import type { RemoteCheckScope, RemoteRootScope } from './repositories/remote-fact-evidence';
import type { RemoteFactInboxDisposition } from './repositories/remote-fact-inbox';

type Loader = Awaited<ReturnType<typeof createRemoteFactLoader>>;
type Variant = RemoteFactIdentityGroup['variants'][number];
type Intrinsic = Awaited<ReturnType<typeof prepareRemoteCoinIntrinsic>>;
type Proofs = Awaited<ReturnType<Intrinsic['proofs']>>;
type Verdict = 'valid' | 'pending' | 'invalid';
const identityKey = ({ factType, factId }: RemoteFactIdentity) => JSON.stringify([factType, factId]);
const variantKey = (fact: PreparedRemoteFact) => JSON.stringify([fact.factType, fact.factId, fact.payloadDigest]);
const ownScope = (a: HabitAction): RemoteCheckScope => ({ boardId: a.boardId, logicalDate: a.logicalDate });
const checkKey = (pair: RemoteCheckScope) => `check:${pair.boardId}:${pair.logicalDate}`;
const rootKey = (pair: RemoteRootScope) => `bonus:${pair.rootId}:${pair.logicalDate}`;
const metadata = (p: PreparedRemoteFact) => ({ factType: p.factType, factId: p.factId, mutationStamp: p.fact!.value.mutationStamp });
const identity = (p: PreparedRemoteFact): RemoteFactIdentity => ({ factType: p.factType, factId: p.factId });
const sorted = <T extends RemoteFactIdentity>(values: Iterable<T>) => [...values].sort((a, b) => identityKey(a) < identityKey(b) ? -1 : 1);

// the caller owns one unchanged loader snapshot and commits only this complete plan.
export async function resolveRemoteFactAdmission(loader: Loader,
  seeds: { checkScopes: readonly RemoteCheckScope[]; rootScopes: readonly RemoteRootScope[] },
  sourceHashing: Hashing, checkpoint: () => void) {
  const hashing = guardRemoteFactHashing(sourceHashing);
  const groups = new Map<string, RemoteFactIdentityGroup>();
  const candidatesByScope = new Map<string, Variant[]>();
  const acceptedByScope = new Map<string, PreparedRemoteFact[]>();
  const pendingFrontier: PreparedRemoteFact[] = [];
  const references = new WeakMap<CoinLedgerRow, RemoteFactIdentity[]>();
  const ledgerByScope = new Map<string, Map<string, PreparedRemoteFact>>();
  const actionsByPair = new Map<string, Map<string, PreparedRemoteFact>>();
  const observersByRoot = new Map<string, Map<string, PreparedRemoteFact>>();
  const rootsByPair = new Map<string, Map<string, Set<string>>>();
  const selected = new Map<string, PreparedRemoteFact>();
  const dirty = new Set<string>();
  const rowDigests = new WeakMap<CoinLedgerRow, string>();
  const scopeCache = new Map<string, { signature: string; intrinsic: Intrinsic; replay: Awaited<ReturnType<Intrinsic['context']['replay']>>;
    proofs?: { signature: string; value: Proofs; parents: Map<string, Awaited<ReturnType<Proofs['correction']>>>; cancellations: Map<string, Awaited<ReturnType<Proofs['cancellation']>>> };
    awards: Map<string, Awaited<ReturnType<Intrinsic['award']>>>; reversals: Map<string, Awaited<ReturnType<Intrinsic['reversal']>>>;
    plan?: { signature: string; value: Awaited<ReturnType<typeof planRemoteCoinScope>> } }>();
  const verdicts = new Map<string, Verdict>();
  const generated = new Map<string, PreparedRemoteFact>();
  const excluded = new Map<string, 'capacity' | 'dependency'>();
  const impacts = new Map(seeds.checkScopes.map(pair => [checkKey(pair), { ...pair }]));
  const explicit = new Set([...seeds.checkScopes.map(checkKey), ...seeds.rootScopes.map(rootKey)]);
  const roots = new Map(seeds.rootScopes.map(pair => [rootKey(pair), { ...pair }]));
  const completed = { check: new Set<string>(), root: new Set<string>(), reverse: new Set<string>() };
  const preparedRows = new Map<string, PreparedRemoteFact>();
  const policyCache = new Map<string, ReturnType<typeof parseCoinPolicy>>();

  function policy(action: HabitAction) {
    if (action.policyJson === null) return null;
    let value = policyCache.get(action.policyJson);
    if (value === undefined) { value = parseCoinPolicy(action.policyJson); policyCache.set(action.policyJson, value); }
    return value;
  }
  function ingest(delta: RemoteFactLoaderDelta) {
    for (const group of delta.groups) {
      const key = identityKey(group.identity);
      groups.set(key, group); dirty.add(key);
      for (const p of [group.accepted, ...group.variants.map(v => v.prepared)]) if (p?.fact?.factType === 'ledger_entry') rowDigests.set(p.fact.value, p.payloadDigest);
      if (group.accepted !== null) {
        pendingFrontier.push(group.accepted);
        if (group.accepted.fact?.factType === 'ledger_entry' && group.accepted.scopeKey !== null) {
          const bucket = acceptedByScope.get(group.accepted.scopeKey) ?? []; bucket.push(group.accepted); acceptedByScope.set(group.accepted.scopeKey, bucket);
        }
      }
      for (const variant of group.variants) {
        if (variant.route === 'classify') {
          pendingFrontier.push(variant.prepared);
          if (variant.prepared.fact?.factType === 'ledger_entry' && variant.prepared.scopeKey !== null) {
            const bucket = candidatesByScope.get(variant.prepared.scopeKey) ?? []; bucket.push(variant); candidatesByScope.set(variant.prepared.scopeKey, bucket);
          }
        }
        const fact = variant.prepared.fact;
        if (variant.route === 'classify') verdicts.set(variantKey(variant.prepared),
          fact?.factType === 'habit_action' || fact?.value.kind === 'claim' ? 'valid' : 'pending');
      }
    }
    for (const pair of delta.completed.checkScopes) completed.check.add(checkKey(pair));
    for (const pair of delta.completed.rootScopes) completed.root.add(rootKey(pair));
    for (const pair of delta.completed.reverseScopes) completed.reverse.add(checkKey(pair));
  }
  ingest(loader.initial);

  function reduce(group: RemoteFactIdentityGroup) {
    if (group.accepted !== null) return group.accepted;
    if (excluded.has(identityKey(group.identity))) return undefined;
    const valid = group.variants.filter(v => v.route === 'classify' && verdicts.get(variantKey(v.prepared)) === 'valid').map(v => v.prepared);
    const derived = generated.get(identityKey(group.identity));
    if (derived !== undefined && !valid.some(v => v.payload === derived.payload)) valid.push(derived);
    const contested = group.variants.some(v => v.previous?.state === 'quarantined' && v.previous.reason === 'conflict');
    return valid.length === 1 && !contested ? valid[0] : undefined;
  }
  function indexFact(p: PreparedRemoteFact, add: boolean) {
    if (p.fact?.factType === 'ledger_entry') {
      if (p.scopeKey !== null) {
        const bucket = ledgerByScope.get(p.scopeKey) ?? new Map<string, PreparedRemoteFact>();
        if (add) bucket.set(identityKey(p), p); else bucket.delete(identityKey(p));
        ledgerByScope.set(p.scopeKey, bucket);
      }
      return;
    }
    const a = p.fact!.value as HabitAction; const id = identityKey(p); const pair = checkKey(ownScope(a));
    const bucket = actionsByPair.get(pair) ?? new Map<string, PreparedRemoteFact>();
    if (add) bucket.set(id, p); else bucket.delete(id);
    actionsByPair.set(pair, bucket);
    const observation = policy(a);
    if (observation === null || observation.rootId === null) return;
    const root = rootKey({ rootId: observation.rootId as BoardId, logicalDate: a.logicalDate });
    const observers = observersByRoot.get(root) ?? new Map<string, PreparedRemoteFact>();
    if (add) observers.set(id, p); else observers.delete(id);
    observersByRoot.set(root, observers);
    for (const boardId of new Set([a.boardId, ...observation.requiredBoardIds])) {
      const key = checkKey({ boardId: boardId as BoardId, logicalDate: a.logicalDate });
      const reverse = rootsByPair.get(key) ?? new Map<string, Set<string>>();
      const owners = reverse.get(root) ?? new Set<string>();
      if (add) owners.add(id); else owners.delete(id);
      if (owners.size > 0) reverse.set(root, owners); else reverse.delete(root);
      rootsByPair.set(key, reverse);
    }
  }
  function authority() {
    for (const key of dirty) {
      const value = reduce(groups.get(key)!);
      const old = selected.get(key);
      if (old !== value) {
        if (old !== undefined) indexFact(old, false);
        if (value === undefined) selected.delete(key); else {
          selected.set(key, value); indexFact(value, true);
          if (value.fact?.factType === 'habit_action' && groups.get(key)!.accepted === null) {
            const pair = ownScope(value.fact.value); impacts.set(checkKey(pair), pair);
          }
        }
      }
    }
    dirty.clear(); return selected;
  }
  function note(p: PreparedRemoteFact, status: Verdict) {
    if (verdicts.get(variantKey(p)) !== status) { verdicts.set(variantKey(p), status); dirty.add(identityKey(p)); }
  }
  function discardGenerated(scopeKey?: string) {
    for (const [id, p] of generated) if (scopeKey === undefined || p.scopeKey === scopeKey) { generated.delete(id); dirty.add(id); }
  }
  const signatures = (facts: readonly PreparedRemoteFact[]) => JSON.stringify(facts.map(p => [identityKey(p), p.payloadDigest]).sort());
  const rowSignature = (rows: readonly CoinLedgerRow[]) => JSON.stringify(rows.map(row => [row.id, rowDigests.get(row)!]).sort());
  function scopeOf(key: string): RemoteCoinScope {
    const [kind, id, logicalDate] = key.split(':');
    return kind === 'check' ? { kind, boardId: id as BoardId, logicalDate: logicalDate as LogicalDate }
      : { kind: 'bonus', rootId: id as BoardId, logicalDate: logicalDate as LogicalDate };
  }
  function direct(row: CoinLedgerRow): RemoteFactIdentity[] {
    const old = references.get(row); if (old !== undefined) return old;
    const value = [
      ...(row.sourceActionId === null ? [] : [{ factType: 'habit_action' as const, factId: row.sourceActionId }]),
      ...[row.reversesId, row.adjustsId].filter(id => id !== null).map(factId => ({ factType: 'ledger_entry' as const, factId })),
      ...(row.provenanceJson === null ? [] : parseCoinProvenance(row.provenanceJson).map(([factType, factId]) => ({ factType, factId }))),
    ];
    references.set(row, value); return value;
  }
  async function extend(needs: RemoteFactLoaderNeeds) {
    checkpoint(); const delta = await loader.extend(needs); checkpoint(); ingest(delta);
    return delta.groups.length + delta.completed.checkScopes.length + delta.completed.rootScopes.length + delta.completed.reverseScopes.length > 0;
  }
  function memberPairs(pair: RemoteRootScope) {
    const ids = new Set<BoardId>([pair.rootId]);
    for (const p of observersByRoot.get(rootKey(pair))?.values() ?? []) {
      const a = p.fact!.value as HabitAction; ids.add(a.boardId);
      for (const id of policy(a)!.requiredBoardIds) ids.add(id as BoardId);
    }
    return [...ids].map(boardId => ({ boardId, logicalDate: pair.logicalDate }));
  }
  async function close() {
    let changed: boolean;
    do {
      authority(); const identities: RemoteFactIdentity[] = [];
      for (const prepared of pendingFrontier.splice(0)) if (prepared.fact?.factType === 'ledger_entry' && prepared.scopeKey !== null) {
        identities.push(...direct(prepared.fact.value));
        const scope = scopeOf(prepared.scopeKey);
        if (scope.kind === 'check') impacts.set(checkKey(scope), { boardId: scope.boardId, logicalDate: scope.logicalDate });
        else roots.set(rootKey(scope), { rootId: scope.rootId, logicalDate: scope.logicalDate });
      }
      for (const key of impacts.keys()) for (const root of rootsByPair.get(key)?.keys() ?? []) {
        const scope = scopeOf(root) as Extract<RemoteCoinScope, { kind: 'bonus' }>;
        roots.set(root, { rootId: scope.rootId, logicalDate: scope.logicalDate });
      }
      const checks = new Map(impacts);
      for (const pair of roots.values()) for (const member of memberPairs(pair)) checks.set(checkKey(member), member);
      changed = await extend({ identities: identities.filter(id => !groups.has(identityKey(id))),
        checkScopes: [...checks.values()].filter(pair => !completed.check.has(checkKey(pair))),
        rootScopes: [...roots.values()].filter(pair => !completed.root.has(rootKey(pair))),
        reverseScopes: [...impacts.values()].filter(pair => !completed.reverse.has(checkKey(pair))),
      });
    } while (changed);
  }
  await close();

  async function prepareRow(row: CoinLedgerRow) {
    const payload = canonicalCoinLedger(row); let prepared = preparedRows.get(payload);
    if (prepared === undefined) {
      prepared = await prepareRemoteFact({ factType: 'ledger_entry', factId: row.id, value: row, enqueueOnAdmission: true }, hashing);
      preparedRows.set(payload, prepared);
      rowDigests.set(prepared.fact!.value as CoinLedgerRow, prepared.payloadDigest);
    }
    return prepared;
  }
  function addGenerated(prepared: PreparedRemoteFact) {
    const key = identityKey(prepared); const old = groups.get(key)!.accepted ?? generated.get(key);
    if (old !== undefined && old !== null && old.payload !== prepared.payload) throw new RemoteFactAdmissionError('integrity');
    generated.set(key, prepared); dirty.add(key);
  }
  const scopeActions = new Map<string, HabitAction[]>();
  let changed = true;
  while (changed) {
    await close();
    const before = new Map([...authority()].map(([id, p]) => [id, p.payloadDigest]));
    const groupCount = groups.size;
    discardGenerated(); scopeActions.clear();
    const blocked = new Set<string>();
    const required = new Map<string, PreparedRemoteFact[]>();
    const scopes = [...impacts.keys(), ...roots.keys()];
    for (const key of scopes) {
      const scope = scopeOf(key); const available = authority();
      const pairs = scope.kind === 'check' ? [scope] : memberPairs(scope);
      const pairKeys = new Set(pairs.map(checkKey));
      const actionFacts = [...pairKeys].flatMap(pair => [...(actionsByPair.get(pair)?.values() ?? [])]);
      const actions = actionFacts.map(p => p.fact!.value as HabitAction);
      scopeActions.set(key, actions);
      const acceptedRows = (acceptedByScope.get(key) ?? []).map(p => p.fact!.value as CoinLedgerRow);
      const scoped = (candidatesByScope.get(key) ?? []).filter(v => !excluded.has(identityKey(v.prepared)));
      const refKeys = new Set([...acceptedRows, ...scoped.map(v => v.prepared.fact!.value as CoinLedgerRow)].flatMap(direct).map(identityKey));
      const knownById = new Map(actionFacts.map(p => [identityKey(p), p]));
      for (const id of refKeys) { const p = available.get(id); if (p !== undefined) knownById.set(id, p); }
      const known = [...knownById.values()];
      const knownFacts = known.map(p => p.fact!);
      const signature = JSON.stringify([actions.map(a => a.id).sort(), signatures(known)]);
      let cache = scopeCache.get(key);
      if (cache?.signature !== signature) {
        const intrinsic = await prepareRemoteCoinIntrinsic({ scope, actions, knownFacts }, sourceHashing);
        // the factory already validated this exact captured action set; hashing failures propagate unchanged.
        const replay = await intrinsic.context.replay(actions);
        cache = { signature, intrinsic, replay, awards: new Map(), reversals: new Map() }; scopeCache.set(key, cache);
      }
      const { intrinsic, replay } = cache;
      const currentRows: PreparedRemoteFact[] = [];
      for (const row of replay.ordinaryRows) currentRows.push(await prepareRow(row));
      await extend({ identities: currentRows.map(identity) });
      for (const prepared of currentRows) addGenerated(prepared);
      required.set(key, currentRows);
      for (const variant of scoped) {
        const row = variant.prepared.fact!.value as CoinLedgerRow;
        if (row.kind === 'check' || row.kind === 'run_bonus') {
          const id = variantKey(variant.prepared); let verdict = cache.awards.get(id);
          if (verdict === undefined) { verdict = await intrinsic.award(row); cache.awards.set(id, verdict); }
          note(variant.prepared, verdict.status);
        }
      }
      const resolvedAwards = authority();
      for (const variant of scoped) {
        const row = variant.prepared.fact!.value as CoinLedgerRow;
        if (row.kind !== 'reversal') continue;
        const original = resolvedAwards.get(identityKey({ factType: 'ledger_entry', factId: row.reversesId! }))?.fact;
        const id = JSON.stringify([variantKey(variant.prepared), original?.factType === 'ledger_entry' ? rowDigests.get(original.value) : null]);
        let verdict = cache.reversals.get(id);
        if (verdict === undefined) { verdict = await intrinsic.reversal(row, original?.factType === 'ledger_entry' ? original.value : undefined); cache.reversals.set(id, verdict); }
        note(variant.prepared, verdict.status);
      }
      authority();
      const ordinary = [...(ledgerByScope.get(key)?.values() ?? [])].map(p => p.fact!.value as CoinLedgerRow).filter(row => row.kind !== 'adjustment');
      const ordinarySignature = rowSignature(ordinary);
      if (cache.proofs?.signature !== ordinarySignature) cache.proofs = { signature: ordinarySignature,
        value: await intrinsic.proofs(ordinary), parents: new Map(), cancellations: new Map() };
      const phase = cache.proofs; const proofs = phase.value;
      async function correction(row: CoinLedgerRow) {
        const id = rowDigests.get(row)!; let verdict = phase.parents.get(id);
        if (verdict === undefined) { verdict = await proofs.correction(row); phase.parents.set(id, verdict); }
        return verdict;
      }
      const handles = new Map<string, ValidatedCoinCorrection>();
      for (const row of acceptedRows) if (row.kind === 'adjustment' && row.adjustsId === null) {
        const verdict = await correction(row);
        if (verdict.status !== 'valid') throw new RemoteFactAdmissionError('integrity');
        handles.set(canonicalCoinLedger(row), verdict.value);
      }
      for (const variant of scoped) {
        const row = variant.prepared.fact!.value as CoinLedgerRow;
        if (row.kind !== 'adjustment' || row.adjustsId !== null) continue;
        const verdict = await correction(row); note(variant.prepared, verdict.status);
        if (verdict.status === 'valid') handles.set(canonicalCoinLedger(row), verdict.value);
      }
      const resolvedParents = authority();
      for (const variant of scoped) {
        const row = variant.prepared.fact!.value as CoinLedgerRow;
        if (row.kind !== 'adjustment' || row.adjustsId === null) continue;
        const parent = resolvedParents.get(identityKey({ factType: 'ledger_entry', factId: row.adjustsId }))?.fact;
        const handle = parent?.factType === 'ledger_entry' ? handles.get(canonicalCoinLedger(parent.value)) : undefined;
        const id = JSON.stringify([variantKey(variant.prepared), handle === undefined ? null : rowDigests.get(parent!.value as CoinLedgerRow)]);
        let verdict = phase.cancellations.get(id);
        if (verdict === undefined) { verdict = await proofs.cancellation(row, handle); phase.cancellations.set(id, verdict); }
        note(variant.prepared, verdict.status);
      }
      const chosen = authority();
      const candidateRows = scoped.filter(v => chosen.get(identityKey(v.prepared)) === v.prepared).map(v => v.prepared.fact!.value as CoinLedgerRow);
      const mandatory = explicit.has(key) || actions.some(action => groups.get(identityKey({ factType: 'habit_action', factId: action.id }))!.accepted === null) || candidateRows.length > 0;
      if (!mandatory) {
        discardGenerated(key);
        required.delete(key);
        continue;
      }
      const planSignature = JSON.stringify([rowSignature(acceptedRows), rowSignature(candidateRows)]);
      if (cache.plan?.signature !== planSignature) cache.plan = { signature: planSignature,
        value: await planRemoteCoinScope({ scope, actions, acceptedRows, candidateRows, knownFacts }, sourceHashing) };
      const plan = cache.plan.value;
      if (plan.capacity === 'blocked') {
        blocked.add(key);
        discardGenerated(key);
        continue;
      }
      const finalRows: PreparedRemoteFact[] = [];
      for (const row of plan.generatedRows) finalRows.push(await prepareRow(row));
      await extend({ identities: finalRows.map(identity) });
      for (const prepared of finalRows) { addGenerated(prepared); required.get(key)!.push(prepared); }
    }

    const semantic = authority();
    if (groups.size !== groupCount || semantic.size !== before.size || [...semantic].some(([id, p]) => before.get(id) !== p.payloadDigest)) continue;

    // mandatory effects connect complete new facts through their exact economic scopes.
    const available = authority(); const parents = new Map<string, string>();
    function representative(node: string): string {
      let root = node;
      while (parents.has(root)) root = parents.get(root)!;
      while (parents.has(node)) { const next = parents.get(node)!; parents.set(node, root); node = next; }
      return root;
    }
    function connect(a: string, b: string) {
      const left = representative(a); const right = representative(b);
      if (left !== right) parents.set(right, left);
    }
    const proposed = new Set([...available.keys()].filter(id => groups.get(id)!.accepted === null));
    for (const [key, actions] of scopeActions) for (const action of actions) {
      const id = identityKey({ factType: 'habit_action', factId: action.id });
      if (proposed.has(id)) connect(id, key);
    }
    for (const id of proposed) {
      const p = available.get(id)!;
      if (p.scopeKey !== null) connect(id, p.scopeKey);
      if (p.fact?.factType === 'ledger_entry') for (const ref of direct(p.fact.value)) {
        const dependency = identityKey(ref); if (proposed.has(dependency)) connect(id, dependency);
      }
    }
    const gates = new Map<string, 'capacity' | 'dependency'>();
    for (const [key, rows] of required) if (rows.some(row => available.get(identityKey(row))?.payload !== row.payload)) {
      gates.set(representative(key), 'dependency');
    }
    for (const key of blocked) gates.set(representative(key), 'capacity');
    const gated = new Set<string>();
    for (const id of proposed) {
      const component = representative(id); const reason = gates.get(component);
      if (reason !== undefined) { excluded.set(id, reason); dirty.add(id); gated.add(component); }
    }
    for (const [component, reason] of gates) if (!gated.has(component)) {
      throw new RemoteFactAdmissionError(reason === 'capacity' ? 'capacity' : 'integrity');
    }
    const after = authority();
    changed = gated.size > 0 || groups.size !== groupCount || after.size !== before.size ||
      [...after].some(([id, p]) => before.get(id) !== p.payloadDigest);
  }

  const final = authority(); const commit: RemoteFactCommitPlan = { insertions: [], enqueue: [], inbox: { removals: [], upserts: [] } };
  const insertions: PreparedRemoteFact[] = []; const admitted: ReturnType<typeof metadata>[] = [];
  const newGenerated: ReturnType<typeof metadata>[] = []; const duplicates: RemoteFactIdentity[] = [];
  const enqueue = new Map<string, ReturnType<typeof metadata>>();
  const removals: RemoteFactCommitPlan['inbox']['removals'][number][] = [];
  const upserts: RemoteFactCommitPlan['inbox']['upserts'][number][] = [];
  for (const group of groups.values()) {
    let chosen = final.get(identityKey(group.identity));
    if (chosen !== undefined && group.accepted === null) {
      insertions.push(chosen);
      const received = group.variants.some(v => v.route === 'classify' && verdicts.get(variantKey(v.prepared)) === 'valid' && v.prepared.payload === chosen!.payload);
      (received ? admitted : newGenerated).push(metadata(chosen));
      if (chosen.enqueueOnAdmission || !received) enqueue.set(identityKey(chosen), metadata(chosen));
    }
    let duplicate = false;
    for (const variant of group.variants) {
      const p = variant.prepared;
      if (chosen !== undefined && p.payloadEncoding === 'canonical_v1' && p.payload === chosen.payload) {
        if (variant.previous !== null) removals.push({ ...identity(p), payloadDigest: p.payloadDigest });
        if (group.accepted !== null) duplicate = true;
        if (p.enqueueOnAdmission) enqueue.set(identityKey(chosen), metadata(chosen));
        continue;
      }
      let disposition: RemoteFactInboxDisposition;
      if (variant.route === 'invalid_diagnostic' || verdicts.get(variantKey(p)) === 'invalid') disposition = { state: 'quarantined', reason: 'invalid' };
      else if (variant.route === 'retained_quarantine') disposition = variant.previous!;
      else if (verdicts.get(variantKey(p)) === 'valid' && excluded.has(identityKey(p))) disposition = excluded.get(identityKey(p)) === 'capacity'
        ? { state: 'blocked_capacity', reason: 'scope_capacity' } : { state: 'pending', reason: 'dependency' };
      else if (chosen !== undefined || verdicts.get(variantKey(p)) === 'valid') disposition = { state: 'quarantined', reason: 'conflict' };
      else disposition = { state: 'pending', reason: 'dependency' };
      upserts.push({ prepared: p, disposition });
    }
    if (duplicate) duplicates.push(group.identity);
  }
  commit.insertions = insertions.map(p => p.fact!); commit.enqueue = sorted(enqueue.values()); commit.inbox = { upserts, removals };
  const affectedChecks = new Map(seeds.checkScopes.map(pair => [checkKey(pair), { ...pair }]));
  const affectedRoots = new Map(seeds.rootScopes.map(pair => [rootKey(pair), { ...pair }]));
  for (const p of insertions) {
    if (p.scopeKey === null) continue;
    const scope = scopeOf(p.scopeKey);
    if (scope.kind === 'check') affectedChecks.set(checkKey(scope), { boardId: scope.boardId, logicalDate: scope.logicalDate });
    else affectedRoots.set(rootKey(scope), { rootId: scope.rootId, logicalDate: scope.logicalDate });
  }
  const insertedIds = new Set(insertions.map(identityKey));
  for (const [key, actions] of scopeActions) if (key.startsWith('bonus:') && actions.some(a => insertedIds.has(identityKey({ factType: 'habit_action', factId: a.id })))) {
    const scope = scopeOf(key) as Extract<RemoteCoinScope, { kind: 'bonus' }>;
    affectedRoots.set(key, { rootId: scope.rootId, logicalDate: scope.logicalDate });
  }
  checkpoint();
  return { commit, admitted: sorted(admitted), generated: sorted(newGenerated), duplicates: sorted(duplicates),
    affected: { checkScopes: [...affectedChecks.values()], rootScopes: [...affectedRoots.values()] } };
}
