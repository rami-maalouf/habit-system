import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import type { HomeBoardCard } from '@/core/domain/queries';
import { radiusCurve, semanticColor, spacing } from '@/theme';

import { deriveBoardColors } from './board-colors';
import { BoardSymbol } from './board-symbol';
import { ProductPressable, useScheme } from '../ui';
import { SevenDayStrip } from './seven-day-strip';
import { BoardCardHistory } from './board-card-history';
import type { BoardLayout } from './use-board-layout';

type BoardCardProps = {
  card: HomeBoardCard;
  layout?: BoardLayout;
  onOpen?: () => void;
  onQuickCheckIn?: () => void;
  quickPending?: boolean;
  editMode?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  testID?: string;
};

export function BoardCard({ card, layout = 'compact', onOpen, onQuickCheckIn, quickPending,
  editMode, onMoveUp, onMoveDown, canMoveUp, canMoveDown, testID }: BoardCardProps) {
  const scheme = useScheme();
  const colors = deriveBoardColors(card.board.accentHex, scheme);
  const compact = layout === 'compact';
  const checked = card.daily?.checkedToday;
  let summary = '';
  if (card.daily) {
    summary = `${card.daily.completedThisWeek}/7 this week`;
    if (card.daily.currentStreak !== null) {
      const unit = card.daily.currentStreak === 1 ? 'day' : 'days';
      summary += `, ${card.daily.currentStreak} ${unit} streak`;
    }
  }

  return (
    <View testID={testID} style={{
      flexDirection: compact ? 'row' : 'column', alignItems: compact ? 'center' : 'stretch',
      backgroundColor: card.board.usesTintedBackground ? colors.tintedCardBackground : semanticColor('secondaryGroupedBackground', scheme),
      borderWidth: 3, borderColor: colors.cardBorder, borderRadius: compact ? 48 : 28,
      borderCurve: radiusCurve, padding: compact ? spacing.md : spacing.sm,
      paddingHorizontal: compact ? spacing.lg : spacing.sm, gap: compact ? spacing.sm : spacing.md,
      minHeight: 76, flex: 1, minWidth: 0,
    }}>
      <ProductPressable onPress={onOpen} label={card.board.title} hint={`Opens the board${summary ? `. ${summary}` : ''}`}
        disabled={!onOpen} stretch style={compact ? { flex: 1, minWidth: 0 } : { paddingHorizontal: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <BoardSymbol symbol={card.board.symbol} color={colors.accent} />
          <AppText variant="headline" numberOfLines={1} selectable={false} style={{ flex: 1, minWidth: 0 }}>
            {card.board.title}
          </AppText>
        </View>
      </ProductPressable>
      {!compact ? <BoardCardHistory card={card} colors={colors} testID={testID} /> : null}
      {editMode ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
          <ProductPressable onPress={onMoveUp} disabled={!canMoveUp} label={`Move ${card.board.title} up`} testID={`${testID}-move-up`}>
            <Icon name="arrowUp" color={colors.accent} />
          </ProductPressable>
          <ProductPressable onPress={onMoveDown} disabled={!canMoveDown} label={`Move ${card.board.title} down`} testID={`${testID}-move-down`}>
            <Icon name="arrowDown" color={colors.accent} />
          </ProductPressable>
        </View>
      ) : (
        <>
          {compact ? <SevenDayStrip strip={card.strip.slice(-7)} colors={colors} barWidth={5} barGap={3} /> : null}
          <ProductPressable onPress={onQuickCheckIn} disabled={quickPending || !onQuickCheckIn}
            role={card.daily ? 'checkbox' : 'button'} checked={checked}
            label={card.daily ? (checked ? 'Checked, double tap to uncheck' : 'Not checked, double tap to check') : `Check in to ${card.board.title}`}
            hint={card.daily ? `${card.board.title}, ${card.today}. ${summary}` : 'Records one check-in for today'}
            testID={`${testID}-quick`} style={{ paddingVertical: compact ? 0 : 8,
              width: compact ? 44 : undefined, borderRadius: compact ? 24 : 16,
              backgroundColor: colors.accent, flexDirection: 'row', gap: 6 }}>
            {checked ? <Icon name="checkmark" size={20} color={colors.onAccent} />
              : <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.onAccent }} />}
            {!compact ? <AppText variant="headline" selectable={false} style={{ color: colors.onAccent, flexShrink: 1 }}>
              {checked ? 'Checked' : 'Check In'}
            </AppText> : null}
          </ProductPressable>
        </>
      )}
    </View>
  );
}
