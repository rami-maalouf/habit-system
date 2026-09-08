import type { SqlDatabase, SqlExecutor } from '../persistence/database';
import { getReceipt, getSettings, insertReceipt, saveHlc } from '../persistence/repositories/support';
import type { HlcState } from '../sync/hybrid-clock';
import { advance, encodeStamp } from '../sync/hybrid-clock';
import type { CommandId } from './ids';
import { isUuidV4 } from './ids';
import type { Clock, Hashing, IdGenerator } from './ports';
import type { DomainResult } from './result';
import { err } from './result';

export type CommandDeps = {
  db: SqlDatabase;
  clock: Clock;
  ids: IdGenerator;
  hashing: Hashing;
};

export type CommandContext = {
  tx: SqlExecutor;
  now: number;
  timeZoneId: string;
  settings: NonNullable<Awaited<ReturnType<typeof getSettings>>>;
  stamp(): string;
};

// preflight users can replay before calling platform services; commands
// recheck inside their transaction so concurrent retries stay idempotent.
export async function replayCommand<Value>(
  db: SqlExecutor,
  commandId: CommandId,
): Promise<DomainResult<Value> | null> {
  if (!isUuidV4(commandId)) {
    return err('validation', 'Command ids must be uuids.', { field: 'commandId' });
  }
  try {
    const receipt = await getReceipt(db, commandId);
    if (receipt === null) return null;
    const replayed = JSON.parse(receipt) as { ok: boolean; value?: Value };
    if (replayed.ok && !('value' in replayed)) {
      replayed.value = undefined;
    }
    return replayed as DomainResult<Value>;
  } catch (cause) {
    return err('database', `The command could not be completed: ${describe(cause)}`, {
      retryable: true,
    });
  }
}

// every command replays its receipt before mutation work, advances the hybrid clock once per mutation stamp, and persists
// receipts and clock state atomically with the mutation. exported for the
// reminder command module, which shares the same envelope
export async function runCommand<Value>(
  deps: CommandDeps,
  commandId: CommandId,
  work: (context: CommandContext) => Promise<DomainResult<Value>>,
): Promise<DomainResult<Value>> {
  if (!isUuidV4(commandId)) {
    return err('validation', 'Command ids must be uuids.', { field: 'commandId' });
  }
  const now = deps.clock.nowUtcMs();
  const timeZoneId = deps.clock.timeZoneId();
  try {
    return await deps.db.withExclusiveTransactionAsync(async (tx) => {
      const replayed = await replayCommand<Value>(tx, commandId);
      if (replayed !== null) return replayed;
      const settings = await getSettings(tx);
      if (!settings) {
        return err('database', 'The database is not initialized.');
      }
      let hlc: HlcState = { wallTime: settings.hlcWallTime, counter: settings.hlcCounter };
      const context: CommandContext = {
        tx,
        now,
        timeZoneId,
        settings,
        stamp: () => {
          hlc = advance(hlc, now);
          return encodeStamp(hlc, settings.deviceId);
        },
      };
      const result = await work(context);
      await saveHlc(tx, hlc);
      await insertReceipt(tx, commandId, JSON.stringify(result), now);
      return result;
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'ReminderSchedulerError') {
      return err('platform', 'Notifications could not be updated. Try again.', {
        retryable: true,
      });
    }
    return err('database', `The command could not be completed: ${describe(cause)}`, {
      retryable: true,
    });
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

