import { useCallback, useRef, useState } from 'react';
import type { TextProps } from 'react-native';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import type { BoardKind } from '@/core/domain/entities';
import type { HeatmapCell, HeatmapWeek } from '@/core/domain/queries';
import { radius, radiusCurve, spacing, typography } from '@/theme';

import type { DerivedBoardColors } from './board-colors';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CELL_GAP = 3;

type HeatmapViewProps = {
  kind: BoardKind;
  weeks: HeatmapWeek[];
  colors: DerivedBoardColors;
  testID?: string;
};

// availability takes precedence over retained history; daily completion is binary.
function cellColor(cell: HeatmapCell, kind: BoardKind, colors: DerivedBoardColors): string {
  if (!cell.eligible) return colors.unavailableCell;
  if (kind === 'daily') return cell.count > 0 ? colors.accent : colors.inactiveBar;
  switch (cell.intensity) {
    case 'low':
      return `${colors.accent}66`;
    case 'medium':
      return `${colors.accent}AA`;
    case 'high':
      return colors.accent;
    default:
      return colors.inactiveBar;
  }
}

function cellLabel(cell: HeatmapCell, kind: BoardKind): string {
  const state = cell.isFuture ? 'future date'
    : !cell.eligible ? 'unavailable'
      : kind === 'daily' ? (cell.count > 0 ? 'checked' : 'not checked')
        : `${cell.count} check-ins`;
  return `${cell.date}, ${state}${cell.isToday ? ', today' : ''}`;
}

// iso monday-through-sunday rows; weeks scroll horizontally, newest at the end
export function HeatmapView({ kind, weeks, colors, testID }: HeatmapViewProps) {
  const { fontScale } = useWindowDimensions();
  const [measuredLabel, setMeasuredLabel] = useState<{ fontScale: number; height: number } | null>(null);
  const rowSize = Math.max(
    typography.caption2.lineHeight,
    Math.ceil(typography.caption2.lineHeight * fontScale),
    measuredLabel?.fontScale === fontScale ? measuredLabel.height : 0,
  );
  const markerScale = rowSize / typography.caption2.lineHeight;
  const initialMeasurement = useRef<{ seen: boolean; pendingSize: number | null }>({ seen: false, pendingSize: null });
  const measureLabel = useCallback<NonNullable<TextProps['onTextLayout']>>((event) => {
    const height = Math.ceil(Math.max(0, ...event.nativeEvent.lines.map((line) => line.height)));
    if (height <= 0) return;
    if (!initialMeasurement.current.seen || initialMeasurement.current.pendingSize !== null) {
      initialMeasurement.current.seen = true;
      if (height > rowSize) initialMeasurement.current.pendingSize = Math.max(height, initialMeasurement.current.pendingSize ?? 0);
    }
    setMeasuredLabel((current) => current?.fontScale === fontScale && current.height >= height
      ? current : { fontScale, height });
  }, [fontScale, rowSize]);
  // native text measurement may resize the grid after its first layout.
  // only that initial correction can scroll; later content preserves position.
  const scrollView = useRef<ScrollView | null>(null);
  const didAutoScroll = useRef(false);
  const autoScrollToEnd = useCallback((scroll: ScrollView | null) => {
    scrollView.current = scroll;
    if (scroll && !didAutoScroll.current) {
      didAutoScroll.current = true;
      scroll.scrollToEnd?.({ animated: false });
    }
  }, []);
  const finishInitialLayout = useCallback((_width: number, height: number) => {
    const expectedHeight = WEEKDAY_LABELS.length * rowSize + (WEEKDAY_LABELS.length - 1) * CELL_GAP;
    if (initialMeasurement.current.pendingSize === rowSize && Math.abs(height - expectedHeight) <= 1) {
      initialMeasurement.current.pendingSize = null;
      scrollView.current?.scrollToEnd({ animated: false });
    }
  }, [rowSize]);
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm }} testID={testID}>
      <View
        style={{ gap: CELL_GAP }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {WEEKDAY_LABELS.map((label) => (
          <View key={label} testID={`heatmap-weekday-${label}`} style={{ height: rowSize, justifyContent: 'center' }}>
            <AppText variant="caption2" selectable={false} onTextLayout={measureLabel}>
              {label}
            </AppText>
          </View>
        ))}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: CELL_GAP }}
        ref={autoScrollToEnd}
        onContentSizeChange={finishInitialLayout}
      >
        {weeks.map((week, weekIndex) => (
          <View key={weekIndex} style={{ gap: CELL_GAP }}>
            {week.days.map((cell) => (
              <View
                key={cell.date}
                accessible
                accessibilityLabel={cellLabel(cell, kind)}
                style={{
                  width: rowSize,
                  height: rowSize,
                  borderRadius: radius.sm / 2,
                  borderCurve: radiusCurve,
                  backgroundColor: cellColor(cell, kind, colors),
                  borderWidth: cell.isToday ? 1.5 : 0,
                  borderColor: cell.isToday ? colors.accent : 'transparent',
                  opacity: cell.isFuture ? 0.25 : 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {cell.eligible && kind === 'daily' && cell.count > 0 ? (
                  <Icon name="checkmark" size={9 * markerScale} color={colors.onAccent} testID={`heatmap-checked-${cell.date}`} />
                ) : null}
                {/* count intensity is never color-only: a dot marks two checks,
                    and a ring marks three or more. */}
                {cell.eligible && kind === 'count' && (cell.intensity === 'medium' || cell.intensity === 'high') ? (
                  <View
                    testID={`heatmap-marker-${cell.date}`}
                    style={{
                      width: 4 * markerScale,
                      height: 4 * markerScale,
                      borderRadius: 2 * markerScale,
                      backgroundColor:
                        cell.intensity === 'high' ? 'transparent' : colors.onAccent,
                      borderWidth: cell.intensity === 'high' ? 1.25 * markerScale : 0,
                      borderColor: colors.onAccent,
                    }}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
