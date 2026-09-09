import { RemoteFactAdmissionError, type PreparedRemoteFact, type RemoteFactIdentity } from '../domain/remote-fact-validation';
import type { RemoteFactInboxVariant } from './repositories/remote-fact-inbox';

export type RecoveredRemoteFact = { prepared: PreparedRemoteFact; previous: RemoteFactInboxVariant };
export type RemoteFactVariantRoute = 'accepted_duplicate' | 'accepted_conflict' |
  'invalid_diagnostic' | 'retained_quarantine' | 'classify';
export type RemoteFactIdentityGroup = {
  identity: RemoteFactIdentity;
  accepted: PreparedRemoteFact | null;
  variants: { prepared: PreparedRemoteFact; previous: RemoteFactInboxVariant | null; route: RemoteFactVariantRoute }[];
};

type Variant = Omit<RemoteFactIdentityGroup['variants'][number], 'route'>;
type Group = Omit<RemoteFactIdentityGroup, 'variants'> & { variants: Map<string, Variant> };
const identityKey = ({ factType, factId }: RemoteFactIdentity) => JSON.stringify([factType, factId]);

function samePayload(left: Omit<PreparedRemoteFact, 'fact'>, right: Omit<PreparedRemoteFact, 'fact'>) {
  return left.payload === right.payload && left.payloadEncoding === right.payloadEncoding &&
    left.payloadBytes === right.payloadBytes && left.logicalDate === right.logicalDate && left.scopeKey === right.scopeKey;
}

function snapshot(input: PreparedRemoteFact): PreparedRemoteFact {
  return { ...input, fact: input.fact === null ? null :
    { ...input.fact, value: { ...input.fact.value } } as PreparedRemoteFact['fact'] };
}

function route({ prepared, previous }: Variant, accepted: PreparedRemoteFact | null): RemoteFactVariantRoute {
  if (prepared.fact === null) return 'invalid_diagnostic';
  if (accepted !== null && samePayload(accepted, prepared)) return 'accepted_duplicate';
  if (previous?.state === 'quarantined') return 'retained_quarantine';
  return accepted === null ? 'classify' : 'accepted_conflict';
}

// inputs have passed preparation or stored recovery in one caller-owned snapshot.
// collation preserves alternatives; only later intrinsic verdicts can establish new conflicts.
export function mergeRemoteFactIdentityGroups(input: {
  supplied: readonly PreparedRemoteFact[];
  stored: readonly RecoveredRemoteFact[];
  accepted: readonly PreparedRemoteFact[];
}): RemoteFactIdentityGroup[] {
  const groups = new Map<string, Group>();
  function groupFor(prepared: PreparedRemoteFact) {
    const key = identityKey(prepared);
    let group = groups.get(key);
    if (!group) {
      group = { identity: { factType: prepared.factType, factId: prepared.factId }, accepted: null, variants: new Map() };
      groups.set(key, group);
    }
    return group;
  }
  function include(prepared: PreparedRemoteFact, previous: RemoteFactInboxVariant | null) {
    const group = groupFor(prepared);
    if (previous && (identityKey(previous) !== identityKey(prepared) ||
      previous.payloadDigest !== prepared.payloadDigest || !samePayload(previous, prepared) ||
      previous.enqueueOnAdmission !== prepared.enqueueOnAdmission)) throw new RemoteFactAdmissionError('integrity');
    if (group.accepted?.payloadDigest === prepared.payloadDigest && !samePayload(group.accepted, prepared)) {
      throw new RemoteFactAdmissionError('integrity');
    }
    const existing = group.variants.get(prepared.payloadDigest);
    if (existing) {
      if (!samePayload(existing.prepared, prepared)) throw new RemoteFactAdmissionError('integrity');
      if (previous && existing.previous && (previous.state !== existing.previous.state ||
        previous.reason !== existing.previous.reason || previous.firstSeenAt !== existing.previous.firstSeenAt ||
        previous.enqueueOnAdmission !== existing.previous.enqueueOnAdmission)) throw new RemoteFactAdmissionError('integrity');
      existing.prepared.enqueueOnAdmission ||= prepared.enqueueOnAdmission;
    } else {
      group.variants.set(prepared.payloadDigest, { prepared: snapshot(prepared), previous: previous && { ...previous } });
    }
  }
  for (const prepared of input.accepted) {
    if (prepared.fact === null || prepared.payloadEncoding !== 'canonical_v1') throw new RemoteFactAdmissionError('integrity');
    const group = groupFor(prepared);
    if (group.accepted && (group.accepted.payloadDigest !== prepared.payloadDigest || !samePayload(group.accepted, prepared))) {
      throw new RemoteFactAdmissionError('integrity');
    }
    // accepted history itself never requests an upload; only matching restore intent does.
    group.accepted = { ...snapshot(prepared), enqueueOnAdmission: false };
  }
  for (const { prepared, previous } of input.stored) include(prepared, previous);
  for (const prepared of input.supplied) include(prepared, null);
  return [...groups.keys()].sort().map(key => {
    const group = groups.get(key)!;
    return { identity: group.identity, accepted: group.accepted,
      variants: [...group.variants.keys()].sort().map(digest => {
        const variant = group.variants.get(digest)!;
        return { ...variant, route: route(variant, group.accepted) };
      }),
    };
  });
}
