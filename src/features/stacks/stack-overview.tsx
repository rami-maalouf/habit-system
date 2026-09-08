import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import type { StackMember, StackSummary } from '@/core/domain/stack-queries';
import { semanticColor, semanticFallbacks, spacing } from '@/theme';

import { BoardSymbol } from '../boards/board-symbol';
import { formatMinuteOfDay } from '../reminders/weekdays';
import { useScheme } from '../ui';

function memberState(member: StackMember): string {
  return [member.eligible ? null : 'Unavailable', member.checked ? 'Checked' : 'Not checked', member.requiredInStack ? null : 'Optional'].filter(Boolean).join(' · ');
}

export function stackLabel(stack: StackSummary): string {
  return `${stack.members.map((member) => `${member.title}, ${memberState(member)}`).join('; ')}. ${stack.currentRun.logicalDate}. ${runLabel(stack)}. ${timeLabel(stack)}. ${weekLabel(stack)}. ${stack.currentStreak}-day streak.`;
}

function runLabel(stack: StackSummary): string {
  return stack.currentRun.available
    ? `${stack.currentRun.checkedRequiredCount} of ${stack.currentRun.requiredCount} required habits checked`
    : 'No required habits for this date';
}

function timeLabel(stack: StackSummary): string {
  return stack.timeHint === null ? 'No usual time' : `Usual time: ${formatMinuteOfDay(stack.timeHint.minute)}`;
}

function weekLabel(stack: StackSummary): string {
  return `${stack.completeRunsThisWeek} complete ${stack.completeRunsThisWeek === 1 ? 'day' : 'days'} this week`;
}

export function StackOverview({ stack, weeklyCounts }: {
  stack: StackSummary; weeklyCounts?: { boardId: string; checks: number }[];
}) {
  const scheme = useScheme();
  const secondary = semanticColor('secondaryLabel', scheme);
  const date = new Date(`${stack.currentRun.logicalDate}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return (
    <View style={{ gap: spacing.lg }}>
      <View style={{ gap: spacing.xs }}>
        <AppText variant="footnote" testID={`stack-date-${stack.rootId}`} accessibilityLabel={`Stack date: ${stack.currentRun.logicalDate}`} style={{ color: secondary }}>{date}</AppText>
        <AppText variant="headline">{runLabel(stack)}</AppText>
        <AppText variant="footnote" style={{ color: secondary }}>{timeLabel(stack)}</AppText>
      </View>
      <View style={{ gap: spacing.lg }}>
        {stack.members.map((member) => {
          const count = weeklyCounts?.find((item) => item.boardId === member.id)?.checks;
          const weekly = count === undefined ? null : `${count} ${member.kind === 'daily' ? (count === 1 ? 'checked day' : 'checked days') : (count === 1 ? 'check' : 'checks')} this week`;
          return (
            <View key={member.id} testID={`stack-member-${member.id}`} accessible accessibilityLabel={[member.title, memberState(member), weekly].filter(Boolean).join(', ')} style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
              <View style={{ width: 30, alignItems: 'center', paddingTop: 2 }}>
                <BoardSymbol symbol={member.symbol} color={member.accentHex} size={24} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
                <AppText variant="headline">{member.title}</AppText>
                <AppText variant="footnote" style={{ color: secondary }}>{memberState(member)}</AppText>
                {weekly ? <AppText variant="footnote" testID={`stack-weekly-${member.id}`}>{weekly}</AppText> : null}
              </View>
              {member.checked ? <Icon name="checkmark" size={18} color={semanticFallbacks.label[scheme]} /> : null}
            </View>
          );
        })}
      </View>
      <View style={{ gap: spacing.xs, borderTopWidth: 0.5, borderTopColor: semanticColor('separator', scheme), paddingTop: spacing.md }}>
        <AppText variant="subheadline">{weekLabel(stack)}</AppText>
        <AppText variant="subheadline">{`${stack.currentStreak}-day streak`}</AppText>
      </View>
    </View>
  );
}
