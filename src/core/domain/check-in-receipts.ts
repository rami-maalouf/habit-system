import type { CheckInId, LogicalDate } from './ids';
import type { DomainResult } from './result';
import { ok } from './result';

export type CreatedCheckInValue = { checkInId: CheckInId; logicalDate: LogicalDate; created: boolean };
export type RemovedCheckInValue = { removedCheckInId: CheckInId; logicalDate: LogicalDate; removedCheckInIds: CheckInId[] };

// pre-daily receipts represented a real creation and a single removal.
// decode their added fields without changing the stored acknowledged result.
export function normalizeCreatedReceipt(
  result: DomainResult<Omit<CreatedCheckInValue, 'created'> & { created?: boolean }>,
): DomainResult<CreatedCheckInValue> {
  if (!result.ok) return result;
  return ok({ ...result.value, created: result.value.created ?? true });
}

export function normalizeRemovedReceipt(
  result: DomainResult<Omit<RemovedCheckInValue, 'removedCheckInIds'> & { removedCheckInIds?: CheckInId[] }>,
): DomainResult<RemovedCheckInValue> {
  if (!result.ok) return result;
  return ok({ ...result.value, removedCheckInIds: result.value.removedCheckInIds ?? [result.value.removedCheckInId] });
}
