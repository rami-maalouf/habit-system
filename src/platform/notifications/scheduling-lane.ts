let pending: Promise<void> = Promise.resolve();

// effects sharing native inventory serialize here; work must never await sql.
export function inSchedulingLane<Value>(work: () => Promise<Value>): Promise<Value> {
  const result = pending.then(work);
  pending = result.then(() => {}, () => {});
  return result;
}

export const PENDING_NOTIFICATION_LIMIT = 64;
