import type { BoardKind } from '@/core/domain/entities';
import type { HeatmapCell, HeatmapWeek } from '@/core/domain/queries';

import type { DerivedBoardColors } from './board-colors';
import { CalendarHeatmap } from '../ui/calendar-heatmap';
import type { CalendarCell } from '../ui/calendar-heatmap';

// availability takes precedence over retained history; daily completion is binary.
function cellColor(cell: HeatmapCell, kind: BoardKind, colors: DerivedBoardColors): string {
  if (!cell.eligible) return colors.unavailableCell;
  if (kind === 'daily') return cell.count > 0 ? colors.accent : colors.inactiveBar;
  switch (cell.intensity) {
    case 'low': return `${colors.accent}66`;
    case 'medium': return `${colors.accent}AA`;
    case 'high': return colors.accent;
    default: return colors.inactiveBar;
  }
}

function presentCell(cell: HeatmapCell, kind: BoardKind, colors: DerivedBoardColors): CalendarCell {
  const state = cell.isFuture ? 'future date' : !cell.eligible ? 'unavailable'
    : kind === 'daily' ? (cell.count > 0 ? 'checked' : 'not checked') : `${cell.count} check-ins`;
  const marker = !cell.eligible ? undefined
    : kind === 'daily' && cell.count > 0 ? { kind: 'checkmark' as const, color: colors.onAccent, testID: `heatmap-checked-${cell.date}` }
      : kind === 'count' && (cell.intensity === 'medium' || cell.intensity === 'high')
        ? { kind: cell.intensity === 'high' ? 'ring' as const : 'dot' as const, color: colors.onAccent, testID: `heatmap-marker-${cell.date}` }
        : undefined;
  return { date: cell.date, label: `${cell.date}, ${state}${cell.isToday ? ', today' : ''}`,
    color: cellColor(cell, kind, colors), isToday: cell.isToday, outlineColor: colors.accent,
    opacity: cell.isFuture ? 0.25 : 1, marker };
}

export function HeatmapView({ kind, weeks, colors, testID }: {
  kind: BoardKind; weeks: HeatmapWeek[]; colors: DerivedBoardColors; testID?: string;
}) {
  return <CalendarHeatmap weeks={weeks.map((week) => ({ days: week.days.map((cell) => presentCell(cell, kind, colors)) }))} testID={testID} />;
}
