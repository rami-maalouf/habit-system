import { useCallback, useRef, useState } from 'react';
import type { TextProps } from 'react-native';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { AppText } from '@/components/foundation/app-text';
import { Icon } from '@/components/foundation/icon';
import { radius, radiusCurve, spacing, typography } from '@/theme';

export type CalendarMarkerValue = { kind: 'checkmark' | 'dot' | 'ring'; color: string; testID?: string };
export type CalendarCell = {
  date: string;
  label: string;
  color: string;
  isToday: boolean;
  outlineColor: string;
  opacity?: number;
  marker?: CalendarMarkerValue;
  testID?: string;
};
export type CalendarWeek = { days: (CalendarCell | null)[] };

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CELL_GAP = 3;

export function CalendarMarker({ marker, scale = 1 }: { marker: CalendarMarkerValue; scale?: number }) {
  if (marker.kind === 'checkmark') return <Icon name="checkmark" size={9 * scale} color={marker.color} testID={marker.testID} />;
  return <View testID={marker.testID} style={{
    width: 4 * scale, height: 4 * scale, borderRadius: 2 * scale,
    backgroundColor: marker.kind === 'ring' ? 'transparent' : marker.color,
    borderWidth: marker.kind === 'ring' ? 1.25 * scale : 0, borderColor: marker.color,
  }} />;
}

// presentation-only calendar grid; callers own dates, state labels and colors.
export function CalendarHeatmap({ weeks, testID }: { weeks: CalendarWeek[]; testID?: string }) {
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
            {week.days.map((cell, dayIndex) => cell === null ? (
              <View key={`padding-${dayIndex}`} style={{ width: rowSize, height: rowSize }} />
            ) : (
              <View
                key={cell.date}
                testID={cell.testID}
                accessible
                accessibilityLabel={cell.label}
                style={{
                  width: rowSize,
                  height: rowSize,
                  borderRadius: radius.sm / 2,
                  borderCurve: radiusCurve,
                  backgroundColor: cell.color,
                  borderWidth: cell.isToday ? 1.5 : 0,
                  borderColor: cell.isToday ? cell.outlineColor : 'transparent',
                  opacity: cell.opacity ?? 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {cell.marker ? <CalendarMarker marker={cell.marker} scale={markerScale} /> : null}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
