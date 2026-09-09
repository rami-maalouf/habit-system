import { captureSyncPage, SYNC_RECORD_BYTES, SYNC_TOKEN_BYTES } from '@/core/sync/sync-page';

const action = { schemaVersion: 2, entityType: 'habit_action', entityId: '00000000-0000-4000-8000-000000000001',
  mutationStamp: '', deleted: true, fields: { extra: -0, policy_json: ' exact ' } };

describe('complete sync page capture', () => {
  it('owns all later records and token scalars while retaining diagnostic defects and signed zero', () => {
    const input = { records: [{ ...action, fields: { ...action.fields } }, { ...action, fields: { note: 'kept' } }], nextToken: 'new', more: false };
    const captured = captureSyncPage(input, null);
    input.records[1].fields.note = 'changed'; input.records.reverse(); input.nextToken = 'changed';
    expect(captured.nextToken).toBe('new');
    expect(captured.records[1].fields.note).toBe('kept');
    expect(Object.is(captured.records[0].fields.extra, -0)).toBe(true);
    expect(captured.records[0]).toMatchObject({ deleted: true, mutationStamp: '', fields: { policy_json: ' exact ' } });
  });
  it.each([null, [], {}, { records: [], nextToken: null, more: true },
    { records: [], nextToken: 'old', more: true }, { records: new Array(1), nextToken: 'new', more: false },
    { records: Array(201).fill(action), nextToken: 'new', more: false },
    { records: [{ ...action, schemaVersion: 1 }], nextToken: 'new', more: false },
    { records: [{ ...action, fields: { nested: {} } }], nextToken: 'new', more: false },
  ])('rejects an unretainable page %j', value => {
    expect(() => captureSyncPage(value, 'old')).toThrow();
  });
  it('bounds an empty token independently and accepts 200 complete records', () => {
    expect(captureSyncPage({ records: Array(200).fill(action), nextToken: null, more: false }, null).records).toHaveLength(200);
    expect(captureSyncPage({ records: [], nextToken: 'x'.repeat(SYNC_TOKEN_BYTES), more: false }, null).nextToken).toHaveLength(SYNC_TOKEN_BYTES);
    expect(() => captureSyncPage({ records: [], nextToken: 'x'.repeat(SYNC_TOKEN_BYTES + 1), more: false }, null)).toThrow();
    expect(() => captureSyncPage({ records: [{ ...action, fields: { note: 'x'.repeat(SYNC_RECORD_BYTES) } }], nextToken: null, more: false }, null)).toThrow();
  });
  it('captures indexed records without executing a caller iterator that can exceed the declared bound', () => {
    const records = [action];
    const iterator = jest.fn(function* () { yield* Array(201).fill(action); });
    Object.defineProperty(records, Symbol.iterator, { value: iterator });
    expect(captureSyncPage({ records, nextToken: null, more: false }, null).records).toHaveLength(1);
    expect(iterator).not.toHaveBeenCalled();
  });
});
