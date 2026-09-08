import { Host, Switch } from '@expo/ui';

import { AppText } from '@/components/foundation/app-text';

import { CoinCapPicker } from './coin-cap-picker';
import type { BoardDraft } from './draft-store';

export function CoinFields({ draft, onChange, disabled }: {
  draft: Pick<BoardDraft, 'earnsCoins' | 'coinCapPerDay'>;
  onChange: (patch: Partial<BoardDraft>) => void;
  disabled: boolean;
}) {
  return (
    <>
      <Host matchContents={{ vertical: true }} style={{ width: '100%' }}>
        <Switch label="Earn Coins" value={draft.earnsCoins} onValueChange={earnsCoins => { if (!disabled) onChange({ earnsCoins }); }} disabled={disabled} testID="earn-coins-toggle" />
      </Host>
      {draft.earnsCoins ? <CoinCapPicker value={draft.coinCapPerDay} onChange={coinCapPerDay => { if (!disabled) onChange({ coinCapPerDay }); }} disabled={disabled} /> : null}
      <AppText variant="footnote">Each eligible check earns 1 coin, up to your daily cap.</AppText>
    </>
  );
}
