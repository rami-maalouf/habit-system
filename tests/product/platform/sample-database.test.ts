import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import { createBoard, createCheckIn, updateBoard } from '@/core/domain/commands';
import type { BoardId, CommandId } from '@/core/domain/ids';
import { err, ok } from '@/core/domain/result';
import * as bootstrap from '@/core/persistence/bootstrap';
import type { SqlExecutor, SqlParams } from '@/core/persistence/database';
import { getBoardById } from '@/core/persistence/repositories/boards';
import type { SampleRuntime } from '@/core/sample/generator';
import { openMemorySqlDatabase } from '@/platform/database/memory';

import { TestClock, TestIds } from '../helpers/test-db';
import sampleRecipe from '../domain/fixtures/sample-recipe.json';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA1: 'SHA-1', SHA256: 'SHA-256' },
  digest: (algorithm: string, bytes: Uint8Array) => mockDigest(algorithm, bytes),
  randomUUID: () => { throw new Error('sample ids must come from its runtime'); },
}));
jest.mock('@/core/sample/generator', () => ({ createSampleRuntime: () => mockCreateSampleRuntime() }));
jest.mock('../../../src/platform/database/index', () => { throw new Error('sample imported the product file opener'); });
jest.mock('../../../src/platform/database/product-core', () => { throw new Error('sample imported product runtime effects'); });
jest.mock('@/platform/database/product-core', () => { throw new Error('sample imported the mapped product core'); });
jest.mock('@/platform/notifications', () => { throw new Error('sample imported notification effects'); });
jest.mock('@/platform/widgets', () => { throw new Error('sample imported widget effects'); });

const mockDigest = jest.fn(async (algorithm: string, bytes: Uint8Array) =>
  new Uint8Array(createHash(algorithm.replace('-', '').toLowerCase()).update(bytes).digest()).buffer);
const runtimes: SampleRuntime[] = [];
function createControlledRuntime(): SampleRuntime {
  const ids = new TestIds();
  const clock = new TestClock(Date.UTC(2026, 8, 9, 16), 'America/Toronto');
  const runtime: SampleRuntime = { ids, clock, populate: jest.fn(async (db, hashing) => {
    const deps = { db, hashing, ids, clock };
    const board = await createBoard(deps, {
      commandId: ids.nextCommandId(), title: 'Factory seed', kind: 'daily',
      symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      earnsCoins: true, coinCapPerDay: 1,
    });
    if (!board.ok) return board;
    const checked = await createCheckIn(deps, { commandId: ids.nextCommandId(), boardId: board.value.boardId, source: 'app' });
    return checked.ok ? ok(undefined) : checked;
  }) };
  runtimes.push(runtime);
  return runtime;
}
const mockCreateSampleRuntime = jest.fn(createControlledRuntime);

// lazy loading keeps the earlier adapter tests runnable during factory red.
async function openSampleCore() {
  const factory = jest.requireActual<typeof import('@/platform/database/sample-core')>('@/platform/database/sample-core');
  return factory.openSampleCore();
}

async function canonicalState(db: SqlExecutor) {
  const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  const entries = [];
  for (const { name } of tables) {
    const rows = await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
    const canonicalRows = rows.map((row) => JSON.stringify(Object.fromEntries(Object.keys(row)
      .filter((key) => name !== 'schema_migrations' || key !== 'applied_at').sort().map((key) => [key, row[key]])))).sort();
    entries.push([name, { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(canonicalRows)).digest('hex') }]);
  }
  return Object.fromEntries(entries);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

function observe<Value>(promise: Promise<Value>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// no queue or transaction wrapper here: the actual adapter must own ordering.
class NativeMemory {
  readonly raw = new DatabaseSync(':memory:');
  readonly events: string[] = [];
  before: (event: string) => Promise<void> = async () => {};
  failure: (event: string) => Error | undefined = () => undefined;
  closed = false;

  private async execute<Value>(event: string, work: () => Value): Promise<Value> {
    this.events.push(event);
    await this.before(event);
    const failure = this.failure(event);
    if (failure) throw failure;
    return work();
  }

  execAsync(sql: string) {
    return this.execute(`exec:${sql}`, () => this.raw.exec(sql));
  }

  runAsync(sql: string, params: SqlParams = []) {
    return this.execute(`run:${sql}`, () => {
      const result = this.raw.prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    });
  }

  getAllAsync<Row>(sql: string, params: SqlParams = []): Promise<Row[]> {
    return this.execute(`all:${sql}`, () => this.raw.prepare(sql).all(...params) as Row[]);
  }

  getFirstAsync<Row>(sql: string, params: SqlParams = []): Promise<Row | null> {
    return this.execute(`first:${sql}`, () => (this.raw.prepare(sql).get(...params) as Row | undefined) ?? null);
  }

  closeAsync = jest.fn(() => this.execute('close', () => {
    this.raw.close();
    this.closed = true;
  }));

  // expo's exclusive helper opens a second connection, which cannot share :memory:.
  withExclusiveTransactionAsync = jest.fn(() => { throw new Error('native transaction helper is forbidden'); });
  withTransactionAsync = jest.fn(() => { throw new Error('native transaction helper is forbidden'); });
}

const handles: NativeMemory[] = [];
function createNative(..._args: unknown[]) {
  const native = new NativeMemory();
  handles.push(native);
  return Promise.resolve(native);
}
const mockOpenDatabaseAsync = jest.fn(createNative);

beforeEach(() => {
  handles.length = 0;
  mockOpenDatabaseAsync.mockReset().mockImplementation(createNative);
  runtimes.length = 0;
  mockCreateSampleRuntime.mockReset().mockImplementation(createControlledRuntime);
  mockDigest.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const native of handles) {
    expect(native.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(native.withTransactionAsync).not.toHaveBeenCalled();
    // cleanup belongs to the test after deliberately failed native closes.
    if (!native.closed) native.raw.close();
  }
});

describe('sample core factory ownership', () => {
  it('bootstraps two fresh cores, populates each once and retains their own continuing runtime', async () => {
    const opened = await Promise.all([openSampleCore(), openSampleCore()]);
    expect(opened.every((result) => result.ok)).toBe(true);
    const cores = opened.map((result) => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    expect(mockCreateSampleRuntime).toHaveBeenCalledTimes(2);
    expect(mockOpenDatabaseAsync.mock.calls).toEqual([
      [':memory:', { useNewConnection: true }], [':memory:', { useNewConnection: true }],
    ]);
    for (const [index, core] of cores.entries()) {
      expect(core.clock).toBe(runtimes[index].clock);
      expect(core.ids).toBe(runtimes[index].ids);
      expect(runtimes[index].populate).toHaveBeenCalledTimes(1);
      expect(runtimes[index].populate).toHaveBeenCalledWith(core.db, core.hashing);
      expect(await core.db.getFirstAsync('PRAGMA user_version')).toEqual({ user_version: 12 });
      expect(await core.db.getFirstAsync('SELECT COUNT(*) AS count FROM schema_migrations')).toEqual({ count: 12 });
      expect(await core.db.getFirstAsync('SELECT version, checksum FROM schema_migrations WHERE version = 12'))
        .toEqual({ version: 12, checksum: '45bc5f98' });
      expect(await core.db.getAllAsync('SELECT kind, delta FROM coin_ledger')).toEqual([{ kind: 'check', delta: 1 }]);
      for (const table of ['miss_alerts', 'remote_fact_inbox', 'sync_deferred']) {
        expect(await core.db.getAllAsync(`SELECT * FROM ${table}`)).toEqual([]);
      }
      expect(Buffer.from(await core.hashing.sha1(new Uint8Array([1, 2, 3]))).toString('hex'))
        .toBe('7037807198c22a7d2b0807371d763779a84fdfcf');
      expect(Buffer.from(await core.hashing.sha256(new Uint8Array([1, 2, 3]))).toString('hex'))
        .toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    }
    const edited = await createBoard(cores[0], {
      commandId: cores[0].ids.uuid() as CommandId, title: 'Independent edit', kind: 'daily',
      symbol: 'book.fill', accentHex: '#4477AA', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
    });
    expect(edited.ok).toBe(true);
    expect(await cores[0].db.getFirstAsync('SELECT COUNT(*) AS count FROM boards')).toEqual({ count: 2 });
    expect(await cores[1].db.getFirstAsync('SELECT COUNT(*) AS count FROM boards')).toEqual({ count: 1 });
    await Promise.all(cores.map((core) => core.db.closeAsync()));
    const fresh = await openSampleCore();
    if (!fresh.ok) throw new Error(fresh.error.message);
    expect(await fresh.value.db.getFirstAsync('SELECT COUNT(*) AS count FROM boards')).toEqual({ count: 1 });
    expect(mockCreateSampleRuntime).toHaveBeenCalledTimes(3);
    await fresh.value.db.closeAsync();
    expect(handles.map((native) => native.closeAsync.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('preserves an actual migration failure and disposes without invoking population', async () => {
    const failure = new Error('injected migration write failure');
    mockOpenDatabaseAsync.mockImplementationOnce(async () => {
      const native = new NativeMemory();
      native.failure = (event) => event.startsWith('run:CREATE TABLE boards') ? failure : undefined;
      handles.push(native);
      return native;
    });
    const result = await openSampleCore();
    expect(result).toEqual(err('migration', 'Database migration failed: injected migration write failure'));
    expect(runtimes[0].populate).not.toHaveBeenCalled();
    expect(handles[0].closeAsync).toHaveBeenCalledTimes(1);
    expect(handles[0].closed).toBe(true);
  });

  it('retains a returned seed failure even if disposal fails, and a later open starts fresh', async () => {
    const failure = err('validation', 'The controlled sample seed was refused.');
    mockCreateSampleRuntime.mockImplementationOnce(() => {
      const runtime = createControlledRuntime();
      runtime.populate = jest.fn(async () => failure);
      return runtime;
    });
    mockOpenDatabaseAsync.mockImplementationOnce(async () => {
      const native = new NativeMemory();
      native.failure = (event) => event === 'close' ? new Error('native disposal failed') : undefined;
      handles.push(native);
      return native;
    });
    expect(await openSampleCore()).toBe(failure);
    expect(handles[0].closeAsync).toHaveBeenCalledTimes(1);
    expect(await handles[0].getAllAsync('SELECT * FROM boards')).toEqual([]);
    const retry = await openSampleCore();
    if (!retry.ok) throw new Error(retry.error.message);
    expect(await retry.value.db.getFirstAsync('SELECT COUNT(*) AS count FROM boards')).toEqual({ count: 1 });
    expect(runtimes).toHaveLength(2);
    await retry.value.db.closeAsync();
  });

  it('disposes and rethrows an unexpected bootstrap failure without entering the seed', async () => {
    const failure = new Error('unexpected bootstrap throw');
    jest.spyOn(bootstrap, 'initializeProductDatabase').mockRejectedValueOnce(failure);
    await expect(openSampleCore()).rejects.toBe(failure);
    expect(runtimes[0].populate).not.toHaveBeenCalled();
    expect(handles[0].closeAsync).toHaveBeenCalledTimes(1);
    expect(handles[0].closed).toBe(true);
  });

  it('disposes partial seed effects and preserves an unexpected throw even if native close also fails', async () => {
    const failure = new Error('unexpected seed throw');
    mockCreateSampleRuntime.mockImplementationOnce(() => {
      const runtime = createControlledRuntime();
      const populate = runtime.populate;
      runtime.populate = jest.fn(async (db, hashing) => {
        const result = await populate(db, hashing);
        if (!result.ok) throw new Error(result.error.message);
        throw failure;
      });
      return runtime;
    });
    mockOpenDatabaseAsync.mockImplementationOnce(async () => {
      const native = new NativeMemory();
      native.failure = (event) => event === 'close' ? new Error('native disposal failed') : undefined;
      handles.push(native);
      return native;
    });
    await expect(openSampleCore()).rejects.toBe(failure);
    expect(await handles[0].getFirstAsync('SELECT COUNT(*) AS count FROM boards')).toEqual({ count: 1 });
    expect(handles[0].closeAsync).toHaveBeenCalledTimes(1);
  });

  it('propagates native allocation failure without trying another handle or product fallback', async () => {
    const failure = new Error('memory allocation failed');
    mockOpenDatabaseAsync.mockRejectedValueOnce(failure);
    await expect(openSampleCore()).rejects.toBe(failure);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(handles).toEqual([]);
  });

  it('opens concurrent complete recipes with exact state, isolated edits and fresh state after closing', async () => {
    const actual = jest.requireActual<typeof import('@/core/sample/generator')>('@/core/sample/generator');
    mockCreateSampleRuntime.mockImplementation(actual.createSampleRuntime);
    const results = await Promise.all([openSampleCore(), openSampleCore()]);
    const cores = results.map((result) => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    expect(mockCreateSampleRuntime).toHaveBeenCalledTimes(2);
    expect(mockOpenDatabaseAsync.mock.calls).toEqual([
      [':memory:', { useNewConnection: true }], [':memory:', { useNewConnection: true }],
    ]);
    const original = await canonicalState(cores[0].db);
    expect(original).toEqual(sampleRecipe.canonicalTables);
    expect(await canonicalState(cores[1].db)).toEqual(original);
    for (const core of cores) {
      expect(core.clock.nowUtcMs()).toBe(Date.UTC(2026, 8, 9, 16));
      expect(core.clock.timeZoneId()).toBe('America/Toronto');
      expect(await core.db.getAllAsync('SELECT version, checksum FROM schema_migrations ORDER BY version')).toEqual([
        { version: 1, checksum: 'c459cef6' }, { version: 2, checksum: '34363ca0' },
        { version: 3, checksum: 'bac085e2' }, { version: 4, checksum: 'dcbb9394' },
        { version: 5, checksum: '633f8fb7' }, { version: 6, checksum: '0191110b' },
        { version: 7, checksum: 'a901fb95' }, { version: 8, checksum: '14ff0dae' },
        { version: 9, checksum: '421ece28' }, { version: 10, checksum: '5d0cab85' },
        { version: 11, checksum: '507c9875' }, { version: 12, checksum: '45bc5f98' },
      ]);
      expect(await core.db.getAllAsync('SELECT kind, COUNT(*) AS count FROM boards GROUP BY kind ORDER BY kind'))
        .toEqual([{ kind: 'count', count: 1 }, { kind: 'daily', count: 7 }]);
      expect(await core.db.getFirstAsync('SELECT COUNT(*) AS count FROM rewards')).toEqual({ count: 4 });
    }
    const identity = await cores[0].db.getFirstAsync<{ id: BoardId }>('SELECT id FROM boards ORDER BY order_key LIMIT 1');
    const board = await getBoardById(cores[0].db, identity!.id);
    expect(board).not.toBeNull();
    const edited = await updateBoard(cores[0], {
      ...board!, commandId: cores[0].ids.uuid() as CommandId, boardId: board!.id,
      expectedMutationStamp: board!.mutationStamp, title: 'Only this sample was edited',
    });
    expect(edited.ok).toBe(true);
    expect(await cores[0].db.getFirstAsync('SELECT title FROM boards WHERE id = ?', [board!.id]))
      .toEqual({ title: 'Only this sample was edited' });
    expect(await canonicalState(cores[0].db)).not.toEqual(original);
    expect(await canonicalState(cores[1].db)).toEqual(original);
    await Promise.all(cores.map((core) => core.db.closeAsync()));
    await Promise.all(cores.map((core) => core.db.closeAsync()));
    expect(handles.map((native) => native.closeAsync.mock.calls.length)).toEqual([1, 1]);
    const reopened = await openSampleCore();
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(await canonicalState(reopened.value.db)).toEqual(original);
    await reopened.value.db.closeAsync();
    expect(mockCreateSampleRuntime).toHaveBeenCalledTimes(3);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(3);
    expect(handles.map((native) => native.closeAsync.mock.calls.length)).toEqual([1, 1, 1]);
  }, 120_000);
});

describe('sample memory connection ownership', () => {
  it('opens separate unnamed databases with foreign keys and no directory or file fallback', async () => {
    const [first, second] = await Promise.all([openMemorySqlDatabase(), openMemorySqlDatabase()]);
    expect(mockOpenDatabaseAsync.mock.calls).toEqual([
      [':memory:', { useNewConnection: true }],
      [':memory:', { useNewConnection: true }],
    ]);
    for (const db of [first, second]) {
      expect(await db.getAllAsync('PRAGMA database_list')).toEqual([{ seq: 0, name: 'main', file: '' }]);
      expect(await db.getFirstAsync('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
      await db.execAsync('CREATE TABLE seed (value INTEGER NOT NULL)');
    }
    await first.runAsync('INSERT INTO seed VALUES (?)', [7]);
    expect(await first.getAllAsync('SELECT value FROM seed')).toEqual([{ value: 7 }]);
    expect(await second.getAllAsync('SELECT value FROM seed')).toEqual([]);
    await Promise.all([first.closeAsync(), second.closeAsync()]);
    expect(handles.map((native) => native.closeAsync.mock.calls.length)).toEqual([1, 1]);
  });

  it('queues a transaction and outside SQL behind held work, then drains accepted work before one shared close', async () => {
    const db = await openMemorySqlDatabase();
    const native = handles[0];
    await db.execAsync('CREATE TABLE seed (value INTEGER NOT NULL)');
    const entered = deferred();
    const release = deferred();
    native.before = async (event) => {
      if (event === 'run:INSERT INTO seed VALUES (1)') {
        entered.resolve();
        await release.promise;
      }
    };
    const outside = db.runAsync('INSERT INTO seed VALUES (1)');
    await entered.promise;
    const transaction = db.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync('INSERT INTO seed VALUES (2)');
      return tx.getAllAsync('SELECT value FROM seed ORDER BY value');
    });
    const firstRow = db.getFirstAsync('SELECT SUM(value) AS total FROM seed');
    const outsideExec = db.execAsync('INSERT INTO seed VALUES (3)');
    const allRows = db.getAllAsync('SELECT value FROM seed ORDER BY value');
    const closing = db.closeAsync();
    expect(db.closeAsync()).toBe(closing);
    const late = observe(db.runAsync('DELETE FROM seed'));
    expect(native.events.some((event) => event.startsWith('exec:BEGIN'))).toBe(false);
    expect(native.closeAsync).not.toHaveBeenCalled();
    release.resolve();
    await outside;
    expect(await transaction).toEqual([{ value: 1 }, { value: 2 }]);
    expect(await firstRow).toEqual({ total: 3 });
    await outsideExec;
    expect(await allRows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    await closing;
    expect(await late).toMatchObject({ ok: false });
    expect(native.events).not.toContain('run:DELETE FROM seed');
    expect(native.events.at(-1)).toBe('close');
    expect(native.closeAsync).toHaveBeenCalledTimes(1);
    await expect(db.getFirstAsync('SELECT 1')).rejects.toThrow();
  });

  it('rolls back a failed callback before allowing queued reads and the next transaction', async () => {
    const db = await openMemorySqlDatabase();
    await db.execAsync('CREATE TABLE seed (value INTEGER NOT NULL)');
    const entered = deferred();
    const release = deferred();
    const failure = new Error('failed sample operation');
    const failed = observe(db.withTransactionAsync(async (tx) => {
      await tx.runAsync('INSERT INTO seed VALUES (1)');
      entered.resolve();
      await release.promise;
      throw failure;
    }));
    await entered.promise;
    const queuedRead = db.getAllAsync('SELECT value FROM seed');
    const next = db.withExclusiveTransactionAsync((tx) => tx.runAsync('INSERT INTO seed VALUES (2)'));
    release.resolve();
    expect(await failed).toEqual({ ok: false, error: failure });
    expect(await queuedRead).toEqual([]);
    expect(await next).toEqual({ changes: 1 });
    expect(await db.getAllAsync('SELECT value FROM seed')).toEqual([{ value: 2 }]);
    await db.closeAsync();
  });

  it('does not roll back a BEGIN that failed or poison the later successful transaction', async () => {
    const db = await openMemorySqlDatabase();
    const native = handles[0];
    await db.execAsync('CREATE TABLE seed (value INTEGER NOT NULL)');
    const failure = new Error('begin failed');
    native.failure = (event) => event.startsWith('exec:BEGIN') ? failure : undefined;
    const callback = jest.fn();
    await expect(db.withExclusiveTransactionAsync(callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    expect(native.events.some((event) => event.startsWith('exec:ROLLBACK'))).toBe(false);
    native.failure = () => undefined;
    await db.withTransactionAsync((tx) => tx.runAsync('INSERT INTO seed VALUES (2)'));
    expect(await db.getFirstAsync('SELECT value FROM seed')).toEqual({ value: 2 });
    await db.closeAsync();
  });

  it('refuses already queued work after COMMIT and rollback both fail instead of treating an open transaction as recovered', async () => {
    const db = await openMemorySqlDatabase();
    const native = handles[0];
    await db.execAsync('CREATE TABLE seed (value INTEGER NOT NULL)');
    const commitEntered = deferred();
    const release = deferred();
    native.before = async (event) => {
      if (event.startsWith('exec:COMMIT')) {
        commitEntered.resolve();
        await release.promise;
      }
    };
    native.failure = (event) => /^exec:(COMMIT|ROLLBACK)/.test(event) ? new Error('native transaction state unknown') : undefined;
    const failed = observe(db.withExclusiveTransactionAsync((tx) => tx.runAsync('INSERT INTO seed VALUES (1)')));
    await commitEntered.promise;
    const queuedWrite = observe(db.runAsync('INSERT INTO seed VALUES (2)'));
    const queuedRead = observe(db.getAllAsync('SELECT value FROM seed'));
    const callback = jest.fn();
    const queuedTransaction = observe(db.withTransactionAsync(callback));
    release.resolve();
    for (const result of await Promise.all([failed, queuedWrite, queuedRead, queuedTransaction])) {
      expect(result).toMatchObject({ ok: false });
    }
    expect(callback).not.toHaveBeenCalled();
    expect(native.events).not.toContain('run:INSERT INTO seed VALUES (2)');
    expect(native.events).not.toContain('all:SELECT value FROM seed');
    expect(native.raw.prepare('SELECT value FROM seed').all()).toEqual([{ value: 1 }]);
    await expect(db.execAsync('DELETE FROM seed')).rejects.toThrow();
    await db.closeAsync();
    expect(native.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('retains a failed close result without retrying the native close or allowing later SQL', async () => {
    const db = await openMemorySqlDatabase();
    const native = handles[0];
    const failure = new Error('native close failed');
    native.failure = (event) => event === 'close' ? failure : undefined;
    const first = db.closeAsync();
    const second = db.closeAsync();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    await expect(db.closeAsync()).rejects.toBe(failure);
    await expect(db.runAsync('CREATE TABLE forbidden (value INTEGER)')).rejects.toThrow();
    expect(native.closeAsync).toHaveBeenCalledTimes(1);
    expect(native.events).not.toContain('run:CREATE TABLE forbidden (value INTEGER)');
  });

  it('closes the owned native handle if connection setup fails before exposing a database', async () => {
    const failure = new Error('foreign-key setup failed');
    mockOpenDatabaseAsync.mockImplementationOnce(async () => {
      const native = new NativeMemory();
      native.failure = (event) => /foreign_keys/i.test(event) ? failure : undefined;
      handles.push(native);
      return native;
    });
    await expect(openMemorySqlDatabase()).rejects.toBe(failure);
    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(handles[0].closeAsync).toHaveBeenCalledTimes(1);
    expect(handles[0].closed).toBe(true);
  });
});
