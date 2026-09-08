import { appendOutbox, saveAnchorPresetMinutes } from '../persistence/repositories/support';
import type { CommandDeps } from './command-context';
import { runCommand } from './command-context';
import type { AnchorPreset, AppSettings } from './entities';
import type { CommandId } from './ids';
import type { DomainResult } from './result';
import { err, ok } from './result';

const PRESET_FIELDS = {
  wake: 'wakeMinute', lunch: 'lunchMinute', dinner: 'dinnerMinute', sleep: 'sleepMinute',
} as const satisfies Record<AnchorPreset, keyof AppSettings>;

export function setAnchorPresetMinute(
  deps: CommandDeps,
  input: { commandId: CommandId; preset: AnchorPreset; minute: number },
): Promise<DomainResult<{ preset: AnchorPreset; minute: number }>> {
  return runCommand(deps, input.commandId, async ({ tx, settings, now, stamp }) => {
    if (!['wake', 'lunch', 'dinner', 'sleep'].includes(input.preset)) {
      return err('validation', 'Choose one of the four built-in anchors.', { field: 'preset' });
    }
    if (!Number.isInteger(input.minute) || input.minute < 0 || input.minute > 1439 || input.minute % 15 !== 0) {
      return err('validation', 'Choose a time in 15-minute steps from 00:00 to 23:45.', { field: 'minute' });
    }
    const field = PRESET_FIELDS[input.preset];
    if (settings[field] !== input.minute) {
      const mutationStamp = stamp();
      await saveAnchorPresetMinutes(tx, { ...settings, [field]: input.minute }, mutationStamp);
      await appendOutbox(tx, 'settings', 'app-settings', mutationStamp, now);
    }
    return ok({ preset: input.preset, minute: input.minute });
  });
}
