import type { AnchorPreset } from '@/core/domain/entities';

export const anchorPresets: readonly { preset: AnchorPreset; label: string }[] = [
  { preset: 'wake', label: 'Waking up' },
  { preset: 'lunch', label: 'Lunch' },
  { preset: 'dinner', label: 'Dinner' },
  { preset: 'sleep', label: 'Sleeping' },
];
