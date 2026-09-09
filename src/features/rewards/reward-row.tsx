import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import type { Reward } from '@/core/domain/entities';
import { radius, radiusCurve, semanticColor, spacing } from '@/theme';

import { BoardSymbol, deriveBoardColors } from '../boards';
import { coinAmountLabel } from '../coins/history-presentation';
import { useProductRouter } from '../sample/navigation';
import { ProductPressable, useScheme } from '../ui';
import { useRewardActivity } from './use-reward-activity';

type Props = {
  reward: Reward; archived: boolean; editing: boolean; claimDisabled: boolean; moving: boolean;
  canMoveUp: boolean; canMoveDown: boolean; onClaim: () => void; onMove: (direction: -1 | 1) => void;
};

export function RewardRow({ reward, archived, editing, claimDisabled, moving, canMoveUp, canMoveDown, onClaim, onMove }: Props) {
  const scheme = useScheme();
  const router = useProductRouter();
  const { isCurrent } = useRewardActivity();
  const colors = deriveBoardColors(reward.accentHex, scheme);
  return <View testID={`reward-row-${reward.id}`} style={{ padding: spacing.lg, marginBottom: spacing.md, gap: spacing.md,
    backgroundColor: semanticColor('secondaryGroupedBackground', scheme), borderRadius: radius.lg, borderCurve: radiusCurve }}>
    <ProductPressable label={`${reward.title}, ${coinAmountLabel(reward.costCoins)}${archived ? ', archived reward' : ''}`}
      hint={archived ? 'Opens restore and delete actions' : 'Edits this reward'} testID={`edit-reward-${reward.id}`}
      disabled={moving} stretch onPress={() => { if (isCurrent()) router.push(`/coins/rewards/${reward.id}`); }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
          borderRadius: radius.md, borderCurve: radiusCurve, backgroundColor: colors.accent }}>
          <BoardSymbol symbol={reward.symbol} color={colors.onAccent} size={28} />
        </View>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <AppText variant="headline" selectable={false}>{reward.title}</AppText>
          <AppText variant="subheadline" selectable={false} style={{ color: semanticColor('secondaryLabel', scheme) }}>{coinAmountLabel(reward.costCoins)}</AppText>
        </View>
        <AppText accessible={false} selectable={false}>›</AppText>
      </View>
    </ProductPressable>
    {!archived && editing ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
      <ProductPressable label={`Move ${reward.title} up`} testID={`reward-move-up-${reward.id}`} disabled={moving || !canMoveUp} onPress={() => onMove(-1)}>
        <AppText selectable={false}>Move up</AppText>
      </ProductPressable>
      <ProductPressable label={`Move ${reward.title} down`} testID={`reward-move-down-${reward.id}`} disabled={moving || !canMoveDown} onPress={() => onMove(1)}>
        <AppText selectable={false}>Move down</AppText>
      </ProductPressable>
    </View> : !archived ? <ProductPressable label={`Claim ${reward.title} for ${coinAmountLabel(reward.costCoins)}`}
      testID={`claim-reward-${reward.id}`} disabled={claimDisabled || moving} stretch onPress={onClaim}
      style={{ alignItems: 'center', borderRadius: radius.md, backgroundColor: semanticColor('fill', scheme), paddingHorizontal: spacing.md }}>
      <AppText variant="headline" selectable={false} style={{ color: semanticColor('label', scheme) }}>Claim</AppText>
    </ProductPressable> : null}
  </View>;
}
