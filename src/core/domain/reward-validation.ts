import type { DomainResult } from './result';
import { err, ok } from './result';
import { validateAccentHex, validateSymbol, validateTitle } from './validation';

export type RewardFields = { title: string; costCoins: number; symbol: string; accentHex: string };

export function validateRewardFields(input: RewardFields): DomainResult<RewardFields> {
  if (typeof input.title !== 'string' || /[\uD800-\uDFFF]/u.test(input.title)) {
    return err('validation', 'Enter a valid reward name.', { field: 'title' });
  }
  if (input.title.trim().length === 0) {
    return err('validation', 'A reward needs a name.', { field: 'title' });
  }
  const title = validateTitle(input.title);
  if (!title.ok) return title;
  if (!Number.isInteger(input.costCoins) || input.costCoins < 1 || input.costCoins > 100000) {
    return err('validation', 'Choose a cost from 1 to 100,000 coins.', { field: 'costCoins' });
  }
  if (typeof input.symbol !== 'string') {
    return err('validation', 'Choose a symbol from the list.', { field: 'symbol' });
  }
  const symbol = validateSymbol(input.symbol);
  if (!symbol.ok) return symbol;
  if (typeof input.accentHex !== 'string') {
    return err('validation', 'Colors use the #RRGGBB form.', { field: 'accentHex' });
  }
  const accent = validateAccentHex(input.accentHex);
  if (!accent.ok) return accent;
  return ok({ title: title.value, costCoins: input.costCoins, symbol: symbol.value, accentHex: accent.value });
}
