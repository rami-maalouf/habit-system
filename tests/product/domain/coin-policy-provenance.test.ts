import { createHash } from 'node:crypto';
import fixture from '@/core/automations/fixtures/check-coins.json';
import { canonicalCoinPolicy, COIN_POLICY_BYTES, COIN_PROOF_BYTES, COIN_PROOF_FACTS, parseCoinPolicy } from '@/core/domain/coin-policy';
import { canonicalCoinProvenance, coinDigest, compareCoinTuple, parseCoinProvenance } from '@/core/domain/coin-provenance';
import type { CoinFingerprint } from '@/core/domain/coin-provenance';

const hashing = { sha256: async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest()) };
const proof = fixture.correction.expectedAppend[0].provenanceJson!;

describe('coin policy and provenance boundaries', () => {
  it.each(fixture.validPolicies)('preserves canonical signed and rooted policy $json', ({ value, json }) => {
    expect(canonicalCoinPolicy(value)).toBe(json);
    expect(parseCoinPolicy(json)).toEqual(value);
  });
  it.each(fixture.invalidPolicies)('rejects malformed or noncanonical policy %s', (json) => {
    expect(() => parseCoinPolicy(json)).toThrow();
  });
  it('rejects non-string or oversized policy before parsing, and bounds a valid large membership snapshot', () => {
    expect(() => parseCoinPolicy(null as never)).toThrow('invalid');
    expect(() => parseCoinPolicy(' '.repeat(COIN_POLICY_BYTES + 1))).toThrow('size');
    const ids = Array.from({ length: 5100 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
    const base = { ...fixture.policy, rootId: ids[0], requiredBoardIds: ids, bonusClosesAtUtc: 0 };
    expect(() => canonicalCoinPolicy(base)).toThrow('size');
    const fits = canonicalCoinPolicy({ ...base, requiredBoardIds: ids.slice(0, 5000) });
    expect(new TextEncoder().encode(fits).length).toBeLessThanOrEqual(COIN_POLICY_BYTES);
  });
  it('matches the literal evidence digest and rejects a broken hashing adapter', async () => {
    expect(await coinDigest(proof, hashing)).toBe(fixture.correction.expectedAppend[0].reconciliationKey);
    await expect(coinDigest(proof, { sha256: async () => new Uint8Array(31) })).rejects.toThrow('invalid');
    expect(compareCoinTuple(['a', 'b'], ['a', 'b'])).toBe(0);
    expect(compareCoinTuple(['a', 'z'], ['aa', 'a'])).toBe(-1);
  });
  it('enforces complete sorted typed unique fingerprints and canonical bytes', () => {
    const facts = parseCoinProvenance(proof);
    expect(canonicalCoinProvenance(facts)).toBe(proof);
    for (const malformed of [null, [], [facts[0][0]], ['other', facts[0][1], facts[0][2]], ['habit_action', 'bad', facts[0][2]], ['habit_action', facts[0][1], 'BAD']]) {
      expect(() => canonicalCoinProvenance([malformed] as CoinFingerprint[])).toThrow('invalid');
    }
    expect(() => canonicalCoinProvenance([facts[0], facts[0]])).toThrow('invalid');
    expect(() => canonicalCoinProvenance([...facts].reverse())).toThrow('invalid');
    expect(() => canonicalCoinProvenance([facts[0], [facts[0][0], facts[0][1], 'f'.repeat(64)]] as CoinFingerprint[])).toThrow('invalid');
    for (const text of ['null', '[]', '{}', '{', '{"version":2,"facts":[]}', ` ${proof}`, proof.replace('"version":1', '"version":1,"extra":true')]) expect(() => parseCoinProvenance(text)).toThrow('invalid');
    expect(() => parseCoinProvenance(null as never)).toThrow('invalid');
  });
  it('bounds proof allocation and the complete maximum-size typed encoding', () => {
    expect(() => parseCoinProvenance(' '.repeat(COIN_PROOF_BYTES + 1))).toThrow('size');
    const facts = Array.from({ length: COIN_PROOF_FACTS }, (_, index): CoinFingerprint => ['habit_action', `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, 'f'.repeat(64)]);
    const encoded = canonicalCoinProvenance(facts);
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(COIN_PROOF_BYTES);
    expect(parseCoinProvenance(encoded)).toEqual(facts);
    expect(() => canonicalCoinProvenance([...facts, facts[0]])).toThrow('size');
  });
  it('excludes claim ids while accepting live and baseline action evidence', () => {
    const liveId = '00000000-0000-4000-8000-000000000001';
    const derivedId = '00000000-0000-5000-8000-000000000001';
    const digest = 'f'.repeat(64);
    const claims: CoinFingerprint[] = [['ledger_entry', liveId, digest]];
    expect(() => canonicalCoinProvenance(claims)).toThrow('invalid');
    expect(() => parseCoinProvenance(JSON.stringify({ version: 1, facts: claims }))).toThrow('invalid');
    const evidence: CoinFingerprint[] = [
      ['habit_action', liveId, digest], ['habit_action', derivedId, digest], ['ledger_entry', derivedId, digest],
    ];
    expect(parseCoinProvenance(canonicalCoinProvenance(evidence))).toEqual(evidence);
  });
});
