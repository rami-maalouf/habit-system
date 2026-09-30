import type { BoardLayout } from './use-board-layout';

export const boardLayoutOptions = [
  { value: 'cards', label: 'Full-width cards', icon: 'layoutCards' },
  { value: 'grid', label: 'Two-column grid', icon: 'layoutGrid' },
  { value: 'compact', label: 'Compact rows', icon: 'layoutCompact' },
  { value: 'summary', label: '14-day summary', icon: 'layoutSummary' },
] as const;

export type BoardLayoutControlProps = {
  layout: BoardLayout;
  disabled: boolean;
  width: number;
  onSelect: (layout: BoardLayout) => void;
};
