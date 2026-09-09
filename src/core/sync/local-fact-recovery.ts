import type { Clock, Hashing } from '../domain/ports';
import { RemoteFactHashingError } from '../domain/remote-fact-hashing';
import type { SqlDatabase } from '../persistence/database';
import { admitRemoteFacts } from '../persistence/remote-fact-admission';
import { rebuildWidgetRows } from '../persistence/projections/widget-rows';
import { refreshCheckVisibility } from '../persistence/repositories/check-visibility';
import { getSettings, saveHlc } from '../persistence/repositories/support';
import { observe } from './hybrid-clock';

// local recovery owns no account, transport, sync marker, command id or receipt.
export async function recoverLocalFacts(deps: { db: SqlDatabase; clock: Clock; hashing: Hashing },
  checkpoint: () => void): Promise<boolean> {
  const raw = { sha1: deps.hashing.sha1.bind(deps.hashing), sha256: deps.hashing.sha256.bind(deps.hashing) };
  try {
    return await deps.db.withExclusiveTransactionAsync(async tx => {
      checkpoint();
      const now = deps.clock.nowUtcMs();
      const timeZoneId = deps.clock.timeZoneId();
      const settings = await getSettings(tx);
      checkpoint();
      if (!settings) throw new Error('The database is not initialized.');
      const result = await admitRemoteFacts(tx, { candidates: [], acquiredNow: now, checkpoint }, raw);
      checkpoint();
      const accepted = [...result.admitted, ...result.generated];
      if (accepted.length > 0) {
        await refreshCheckVisibility(tx, result.affected.checkScopes);
        checkpoint();
        let hlc = { wallTime: settings.hlcWallTime, counter: settings.hlcCounter };
        for (const fact of accepted) hlc = observe(hlc, fact.mutationStamp);
        if (hlc.wallTime !== settings.hlcWallTime || hlc.counter !== settings.hlcCounter) {
          await saveHlc(tx, hlc);
          checkpoint();
        }
        await rebuildWidgetRows(tx, now, timeZoneId);
        checkpoint();
      }
      return result.localChanged;
    });
  } catch (cause) {
    // unwrap one owned provider layer only after the acquired transaction rolled back.
    if (cause instanceof RemoteFactHashingError) throw cause.cause;
    throw cause;
  }
}
