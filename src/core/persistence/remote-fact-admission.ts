import { isValidLogicalDate } from '../calendar/logical-date';
import { isUuidV4 } from '../domain/ids';
import type { Hashing } from '../domain/ports';
import { RemoteFactHashingError } from '../domain/remote-fact-hashing';
import { prepareRemoteFacts, RemoteFactAdmissionError, type RemoteFactCandidate } from '../domain/remote-fact-validation';
import type { SqlExecutor } from './database';
import { commitRemoteFacts } from './remote-fact-commit';
import { createRemoteFactLoader } from './remote-fact-loader';
import { resolveRemoteFactAdmission } from './remote-fact-resolution';
import type { RemoteCheckScope, RemoteRootScope } from './repositories/remote-fact-evidence';

export type RemoteFactAdmissionInput = {
  candidates: readonly RemoteFactCandidate[];
  acquiredNow: number;
  checkScopes?: readonly RemoteCheckScope[];
  rootScopes?: readonly RemoteRootScope[];
  checkpoint?: () => void;
};

// this captures exact caller-known pairs; discovery of historical economic scopes is separate.
function snapshotScopes(input: RemoteFactAdmissionInput) {
  function pair<Scope extends RemoteCheckScope | RemoteRootScope>(scope: Scope) {
    const id = 'boardId' in scope ? scope.boardId : scope.rootId;
    if (typeof id !== 'string' || !isUuidV4(id) || typeof scope.logicalDate !== 'string' || !isValidLogicalDate(scope.logicalDate)) {
      throw new RemoteFactAdmissionError('envelope');
    }
    return scope;
  }
  return {
    checkScopes: (input.checkScopes ?? []).map(({ boardId, logicalDate }) => pair({ boardId, logicalDate })),
    rootScopes: (input.rootScopes ?? []).map(({ rootId, logicalDate }) => pair({ rootId, logicalDate })),
  };
}

// the caller retains this transaction through visibility, projections, hlc and its receipt/token.
export async function admitRemoteFacts(tx: SqlExecutor, input: RemoteFactAdmissionInput, sourceHashing: Hashing) {
  const acquiredNow = input.acquiredNow;
  const checkpoint = input.checkpoint ?? (() => {});
  if (!Number.isSafeInteger(acquiredNow) || acquiredNow < 0 || Object.is(acquiredNow, -0) || typeof checkpoint !== 'function') {
    throw new RemoteFactAdmissionError('envelope');
  }
  const scopes = snapshotScopes(input);
  let raw: Hashing;
  try { raw = { sha1: sourceHashing.sha1.bind(sourceHashing), sha256: sourceHashing.sha256.bind(sourceHashing) }; }
  catch (cause) { throw new RemoteFactHashingError(cause); }
  checkpoint();
  const prepared = await prepareRemoteFacts(input.candidates, raw);
  checkpoint();
  const loader = await createRemoteFactLoader({ tx, sourceHashing: raw }, prepared);
  checkpoint();
  const { commit, ...summary } = await resolveRemoteFactAdmission(loader, scopes, raw, checkpoint);
  checkpoint();
  const result = await commitRemoteFacts(tx, commit, acquiredNow, checkpoint);
  checkpoint();
  return { ...summary, ...result };
}
