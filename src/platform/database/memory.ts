import * as SQLite from 'expo-sqlite';

import type { SqlDatabase, SqlExecutor } from '@/core/persistence/database';

export async function openMemorySqlDatabase(): Promise<SqlDatabase> {
  const native = await SQLite.openDatabaseAsync(':memory:', { useNewConnection: true });
  try {
    await native.execAsync('PRAGMA foreign_keys = ON');
  } catch (cause) {
    await native.closeAsync().catch(() => undefined);
    throw cause;
  }

  let queue: Promise<void> = Promise.resolve();
  let closing: Promise<void> | null = null;
  let poisoned: Error | null = null;

  function enqueue<Value>(work: () => Promise<Value>): Promise<Value> {
    if (closing) return Promise.reject(new Error('The sample database is closed.'));
    const result = queue.then(() => {
      // a failed rollback also prevents work accepted before that failure.
      if (poisoned) throw poisoned;
      return work();
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  // transaction callbacks use this direct executor on the same native handle.
  const executor: SqlExecutor = {
    runAsync: async (sql, params = []) => {
      const result = await native.runAsync(sql, params);
      return { changes: result.changes };
    },
    getAllAsync: (sql, params = []) => native.getAllAsync(sql, params),
    getFirstAsync: (sql, params = []) => native.getFirstAsync(sql, params),
  };

  function transaction<Value>(
    begin: 'BEGIN' | 'BEGIN EXCLUSIVE', work: (tx: SqlExecutor) => Promise<Value>,
  ): Promise<Value> {
    return enqueue(async () => {
      await native.execAsync(begin);
      try {
        const value = await work(executor);
        await native.execAsync('COMMIT');
        return value;
      } catch (cause) {
        try {
          await native.execAsync('ROLLBACK');
        } catch (rollbackCause) {
          poisoned = new Error('The sample database could not roll back.', { cause: rollbackCause });
        }
        throw cause;
      }
    });
  }

  return {
    runAsync: (sql, params) => enqueue(() => executor.runAsync(sql, params)),
    getAllAsync: (sql, params) => enqueue(() => executor.getAllAsync(sql, params)),
    getFirstAsync: (sql, params) => enqueue(() => executor.getFirstAsync(sql, params)),
    execAsync: (sql) => enqueue(() => native.execAsync(sql)),
    withExclusiveTransactionAsync: (work) => transaction('BEGIN EXCLUSIVE', work),
    withTransactionAsync: (work) => transaction('BEGIN', work),
    closeAsync: () => {
      // mark closing immediately; drain accepted work even when it is poisoned.
      closing ??= queue.then(() => native.closeAsync());
      return closing;
    },
  };
}
