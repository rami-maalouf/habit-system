import { isUuidV4, isUuidV5 } from '../domain/ids';
import { RemoteFactAdmissionError, type RemoteFactCandidate } from '../domain/remote-fact-validation';

export const IMMUTABLE_FIELD_MAP = {
  habit_action: {
    id: 'id', command_id: 'commandId', board_id: 'boardId', logical_date: 'logicalDate',
    check_in_id: 'checkInId', kind: 'kind', created_at: 'createdAt', policy_json: 'policyJson',
  },
  ledger_entry: {
    id: 'id', kind: 'kind', delta: 'delta', board_id: 'boardId', check_in_id: 'checkInId',
    run_key: 'runKey', reward_id: 'rewardId', reward_title_snapshot: 'rewardTitleSnapshot',
    reverses_id: 'reversesId', scope_key: 'scopeKey', source_action_id: 'sourceActionId',
    reconciliation_key: 'reconciliationKey', adjusts_id: 'adjustsId', provenance_json: 'provenanceJson',
    logical_date: 'logicalDate', created_at: 'createdAt', deleted_at: 'deletedAt',
  },
} as const;

const envelopeKeys = ['schemaVersion', 'entityType', 'entityId', 'mutationStamp', 'deleted', 'fields'];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// transport has no economic authority: admission validates these captured bytes.
export function immutableSyncCandidate(input: unknown): RemoteFactCandidate {
  if (!object(input) || Object.keys(input).length !== envelopeKeys.length ||
    !envelopeKeys.every(key => Object.hasOwn(input, key))) throw new RemoteFactAdmissionError('envelope');
  const { schemaVersion, entityType, entityId, mutationStamp, deleted, fields: suppliedFields } = input;
  if (schemaVersion !== 2 || (entityType !== 'habit_action' && entityType !== 'ledger_entry') ||
    typeof entityId !== 'string' || !(isUuidV4(entityId) || isUuidV5(entityId)) ||
    typeof mutationStamp !== 'string' || typeof deleted !== 'boolean' || !object(suppliedFields)) {
    throw new RemoteFactAdmissionError('envelope');
  }
  const entries = Object.entries(suppliedFields);
  if (entries.some(([, value]) => value !== null && typeof value !== 'string' &&
    (typeof value !== 'number' || !Number.isFinite(value)))) throw new RemoteFactAdmissionError('envelope');
  const fields = Object.fromEntries(entries);
  const mapping = Object.entries(IMMUTABLE_FIELD_MAP[entityType]);
  const exactFields = entries.length === mapping.length && mapping.every(([key]) => Object.hasOwn(fields, key));
  // retaining the whole defective wire prevents erased flags/keys from gaining authority.
  const value = !deleted && exactFields
    ? { ...Object.fromEntries(mapping.map(([wire, domain]) => [domain, fields[wire]])), mutationStamp }
    : { schemaVersion, entityType, entityId, mutationStamp, deleted, fields };
  return { factType: entityType, factId: entityId, value, enqueueOnAdmission: false };
}
