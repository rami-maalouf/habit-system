import { isUuidV4 } from './ids';

export const COIN_POLICY_BYTES = 196_608;
export const COIN_RECORD_BYTES = 786_432;
export const COIN_PROOF_BYTES = 524_288;
export const COIN_PROOF_FACTS = 4096;

export class CoinContractError extends Error {
  constructor(readonly reason: 'invalid' | 'size' | 'missing') {
    super(`Coin evidence ${reason}.`);
    this.name = 'CoinContractError';
  }
}

export type CoinPolicy = {
  version: 1;
  boardKind: 'daily' | 'count';
  earnsCoins: boolean;
  coinCapPerDay: number;
  checkClosesAtUtc: number;
  rootId: string | null;
  requiredBoardIds: string[];
  bonusClosesAtUtc: number | null;
  bonusEnabled: boolean;
};

const keys = ['version', 'boardKind', 'earnsCoins', 'coinCapPerDay', 'checkClosesAtUtc',
  'rootId', 'requiredBoardIds', 'bonusClosesAtUtc', 'bonusEnabled'];

export function canonicalCoinPolicy(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CoinContractError('invalid');
  const p = input as CoinPolicy;
  if (Object.keys(p).length !== keys.length || !keys.every((key) => Object.hasOwn(p, key)) ||
    p.version !== 1 || !['daily', 'count'].includes(p.boardKind) || typeof p.earnsCoins !== 'boolean' ||
    !Number.isInteger(p.coinCapPerDay) || p.coinCapPerDay < 1 || p.coinCapPerDay > 10 ||
    !Number.isSafeInteger(p.checkClosesAtUtc) || Object.is(p.checkClosesAtUtc, -0) ||
    (p.rootId !== null && (typeof p.rootId !== 'string' || !isUuidV4(p.rootId))) ||
    !Array.isArray(p.requiredBoardIds) || !p.requiredBoardIds.every((id, index) =>
      typeof id === 'string' && isUuidV4(id) && (index === 0 || p.requiredBoardIds[index - 1] < id)) ||
    (p.bonusClosesAtUtc !== null && (!Number.isSafeInteger(p.bonusClosesAtUtc) || Object.is(p.bonusClosesAtUtc, -0))) ||
    typeof p.bonusEnabled !== 'boolean' ||
    (p.rootId === null ? p.requiredBoardIds.length !== 0 || p.bonusClosesAtUtc !== null || p.bonusEnabled : p.bonusClosesAtUtc === null) ||
    (p.bonusEnabled && p.requiredBoardIds.length === 0)) throw new CoinContractError('invalid');
  const json = JSON.stringify({ version: p.version, boardKind: p.boardKind, earnsCoins: p.earnsCoins,
    coinCapPerDay: p.coinCapPerDay, checkClosesAtUtc: p.checkClosesAtUtc, rootId: p.rootId,
    requiredBoardIds: p.requiredBoardIds, bonusClosesAtUtc: p.bonusClosesAtUtc, bonusEnabled: p.bonusEnabled });
  if (new TextEncoder().encode(json).length > COIN_POLICY_BYTES) throw new CoinContractError('size');
  return json;
}

export function parseCoinPolicy(json: string): CoinPolicy {
  if (typeof json !== 'string') throw new CoinContractError('invalid');
  if (new TextEncoder().encode(json).length > COIN_POLICY_BYTES) throw new CoinContractError('size');
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new CoinContractError('invalid'); }
  if (canonicalCoinPolicy(value) !== json) throw new CoinContractError('invalid');
  return value as CoinPolicy;
}
