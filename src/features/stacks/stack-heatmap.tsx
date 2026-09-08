import { View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { isoWeekday } from '@/core/calendar/logical-date';
import type { StackHeatmapCell } from '@/core/domain/stack-analytics';
import { brand, semanticColor, semanticFallbacks, spacing } from '@/theme';

import { deriveBoardColors } from '../boards/board-colors';
import { useScheme } from '../ui';
import { CalendarHeatmap, CalendarMarker } from '../ui/calendar-heatmap';
import type { CalendarCell, CalendarMarkerValue, CalendarWeek } from '../ui/calendar-heatmap';

export function StackHeatmap({ cells }: { cells: StackHeatmapCell[] }) {
  const scheme = useScheme();
  const colors = deriveBoardColors(brand.accent[scheme], scheme);
  const fills = { unavailable: colors.unavailableCell, none: colors.inactiveBar,
    some: `${colors.accent}66`, most: `${colors.accent}AA`, all: colors.accent };
  function marker(state: StackHeatmapCell['state'], testID?: string): CalendarMarkerValue | undefined {
    if (state === 'none' || state === 'unavailable') return undefined;
    return { kind: state === 'all' ? 'checkmark' : state === 'most' ? 'ring' : 'dot',
      color: state === 'all' ? colors.onAccent : semanticFallbacks.label[scheme], testID };
  }
  const today = cells.at(-1)?.logicalDate;
  const presented: (CalendarCell | null)[] = cells.length > 0 ? Array(isoWeekday(cells[0].logicalDate) - 1).fill(null) : [];
  for (const cell of cells) {
    const state = cell.state === 'unavailable' ? 'unavailable, no required habits'
      : `${cell.state}, ${cell.checkedRequiredCount} of ${cell.requiredCount} required habits checked`;
    presented.push({ date: cell.logicalDate, label: `${cell.logicalDate}, ${state}${cell.logicalDate === today ? ', today' : ''}`,
      color: fills[cell.state], isToday: cell.logicalDate === today, outlineColor: colors.accent,
      marker: marker(cell.state, `stack-marker-${cell.logicalDate}`), testID: `stack-day-${cell.logicalDate}` });
  }
  while (presented.length % 7 !== 0) presented.push(null);
  const weeks: CalendarWeek[] = [];
  for (let index = 0; index < presented.length; index += 7) weeks.push({ days: presented.slice(index, index + 7) });
  return (
    <View style={{ gap: spacing.lg }}>
      <CalendarHeatmap weeks={weeks} testID="stack-heatmap" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }} testID="stack-heatmap-legend">
        {(['none', 'some', 'most', 'all', 'unavailable'] as const).map((state) => {
          const glyph = marker(state);
          return (
            <View key={state} accessible accessibilityLabel={state === 'unavailable' ? 'Unavailable: no required habits' : `${state}: ${state === 'none' ? 'none checked' : state === 'some' ? 'up to half checked' : state === 'most' ? 'more than half checked' : 'all required habits checked'}`} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
              <View style={{ width: 16, height: 16, borderRadius: 3, backgroundColor: fills[state], alignItems: 'center', justifyContent: 'center' }}>
                {glyph ? <CalendarMarker marker={glyph} /> : null}
              </View>
              <AppText variant="caption1" style={{ color: semanticColor('secondaryLabel', scheme) }}>{state[0].toUpperCase() + state.slice(1)}</AppText>
            </View>
          );
        })}
      </View>
    </View>
  );
}
