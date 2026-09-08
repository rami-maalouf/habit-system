import { COIN_PROOF_BYTES, COIN_PROOF_FACTS, CoinContractError } from './coin-policy';
import { isUuidV4, isUuidV5 } from './ids';
import type { Hashing } from './ports';

export type CoinFingerprint = ['habit_action' | 'ledger_entry', string, string];

export function compareCoinTuple(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export async function coinDigest(value: string, hashing: Pick<Hashing, 'sha256'>): Promise<string> {
  const digest = await hashing.sha256(new TextEncoder().encode(value));
  if (digest.length !== 32) throw new CoinContractError('invalid');
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalCoinProvenance(facts: readonly CoinFingerprint[]): string {
  if (facts.length > COIN_PROOF_FACTS) throw new CoinContractError('size');
  const seen = new Set<string>();
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    if (!Array.isArray(fact) || fact.length !== 3 || !['habit_action', 'ledger_entry'].includes(fact[0]) ||
      typeof fact[1] !== 'string' || !(isUuidV5(fact[1]) || (fact[0] === 'habit_action' && isUuidV4(fact[1]))) ||
      typeof fact[2] !== 'string' || !/^[0-9a-f]{64}$/.test(fact[2]) ||
      (index > 0 && compareCoinTuple(facts[index - 1], fact) >= 0)) throw new CoinContractError('invalid');
    const identity = JSON.stringify(fact.slice(0, 2));
    if (seen.has(identity)) throw new CoinContractError('invalid');
    seen.add(identity);
  }
  const json = JSON.stringify({ version: 1, facts });
  // fixed-size typed fingerprints and the count cap fit the byte budget;
  // unparsed input is separately bounded before allocating its json graph.
  return json;
}

export function parseCoinProvenance(json: string): CoinFingerprint[] {
  if (typeof json !== 'string') throw new CoinContractError('invalid');
  if (new TextEncoder().encode(json).length > COIN_PROOF_BYTES) throw new CoinContractError('size');
  let value: { version: unknown; facts: CoinFingerprint[] };
  try { value = JSON.parse(json); } catch { throw new CoinContractError('invalid'); }
  if (value === null || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.facts) ||
    canonicalCoinProvenance(value.facts) !== json) throw new CoinContractError('invalid');
  return value.facts;
}
