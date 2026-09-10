import { createOperationOwner } from '@/features/product-store/operation-scope';
import type { FeatureEffects } from '@/features/product-store/context';
import { createReminder } from '@/core/domain/reminder-commands';
import { missAlertScheduler } from '@/testing/notifications-platform.mock';

import { createTestHarness, type TestHarness } from '../helpers/test-db';
import { createBoardForTest } from '../helpers/product-fixtures';
import { FakeReminderScheduler } from '../helpers/fake-scheduler';

function held<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('product operation ownership', () => {
  let harness: TestHarness;
  beforeEach(async () => { harness = await createTestHarness(); });
  afterEach(async () => { await harness.db.closeAsync(); });

  it('keeps one core and draft key while permanently retiring captured callbacks', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const key = owner.core;
    const drafts = new WeakMap([[key, { title: 'unfinished' }]]);
    const original = owner.getScope();
    expect(original.kind).toBe('sample');
    expect(Object.isFrozen(original)).toBe(true);
    const joining = owner.suspend();
    expect(original.isCurrent()).toBe(false);
    expect(owner.getScope().active).toBe(false);
    const effect = jest.fn(async () => 'should not run');
    expect(await original.run(effect)).toEqual({ started: false });
    await joining;
    owner.resume();
    const resumed = owner.getScope();
    expect(resumed).not.toBe(original);
    expect(resumed.active).toBe(true);
    expect(resumed.isCurrent()).toBe(true);
    expect(await original.run(effect)).toEqual({ started: false });
    expect(effect).not.toHaveBeenCalled();
    expect(owner.core).toBe(key);
    expect(drafts.get(owner.core)).toEqual({ title: 'unfinished' });
    expect(owner.core.ids).toBe(harness.ids);
    expect(owner.core.clock).toBe(harness.clock);
    expect(owner.core.hashing).toBe(harness.deps.hashing);
  });

  it('joins an accepted permission-to-SQL continuation and preserves its factual result', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const permission = held<void>();
    const scope = owner.getScope();
    let began = false;
    const result = scope.run(async ({ core, effects }) => {
      began = true;
      expect(core).toBe(harness.deps);
      expect(effects).toEqual({ kind: 'sample-disabled' });
      await permission.promise;
      await core.db.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      return 'committed';
    });
    expect(began).toBe(true);
    let joined = false;
    const joining = owner.suspend().then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(await owner.getScope().run(async () => 'unexpected')).toEqual({ started: false });
    await expect(owner.core.db.getAllAsync('SELECT * FROM boards')).rejects.toThrow('inactive');
    permission.resolve();
    expect(await result).toEqual({ started: true, value: 'committed' });
    await joining;
    expect(await harness.db.getFirstAsync('SELECT icloud_sync_enabled FROM app_settings')).toEqual({ icloud_sync_enabled: 1 });
    expect(scope.isCurrent()).toBe(false);
  });

  it('joins every accepted operation even when the first one rejects', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const failure = held<void>();
    const success = held<void>();
    const reason = new Error('native failure');
    const failed = owner.getScope().run(() => failure.promise);
    const failedCheck = expect(failed).rejects.toBe(reason);
    const succeeded = owner.getScope().run(() => success.promise);
    const joining = owner.suspend();
    expect(owner.suspend()).toBe(joining);
    let joined = false;
    void joining.then(() => { joined = true; });
    failure.reject(reason);
    await failedCheck;
    expect(joined).toBe(false);
    success.resolve();
    expect(await succeeded).toEqual({ started: true, value: undefined });
    await joining;
    expect(joined).toBe(true);
  });

  it('registers a synchronous callback before that callback can suspend its owner', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const release = held<void>();
    let joining!: Promise<void>;
    let joined = false;
    const work = owner.getScope().run(async () => {
      joining = owner.suspend();
      void joining.then(() => { joined = true; });
      await release.promise;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    release.resolve();
    await work;
    await joining;
    expect(joined).toBe(true);
  });

  it('finishes a public reminder command after its accepted system prompt while fresh work is refused', async () => {
    const boardId = await createBoardForTest(harness);
    const scheduler = new FakeReminderScheduler();
    scheduler.auth = 'undetermined';
    const prompt = held<'granted'>();
    const prompting = held<void>();
    jest.spyOn(scheduler, 'requestAuthorization').mockImplementation(() => {
      prompting.resolve();
      return prompt.promise;
    });
    const effects: FeatureEffects = {
      kind: 'real', reminders: scheduler, missAlerts: missAlertScheduler,
      cloudKitAvailable: jest.fn(), pickImportFile: jest.fn(), saveAndShareExport: jest.fn(),
      supportsAlternateIcons: jest.fn(), setAlternateIcon: jest.fn(),
      openSystemSettings: jest.fn(), openReleaseLink: jest.fn(),
    };
    const owner = createOperationOwner(harness.deps, effects);
    const original = owner.getScope();
    expect(original.kind).toBe('real');
    const commandId = harness.ids.nextCommandId();
    const saved = original.run(({ core, effects: accepted }) => {
      if (accepted.kind !== 'real') throw new Error('expected real ports');
      return createReminder({ ...core, scheduler: accepted.reminders }, {
        commandId, boardId, weekdaysMask: 1, minuteOfDay: 540, enabled: true,
      });
    });
    await prompting.promise;
    let joined = false;
    const joining = owner.suspend().then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    expect(await harness.db.getAllAsync('SELECT * FROM reminders')).toEqual([]);
    prompt.resolve('granted');
    const result = await saved;
    await joining;
    expect(result).toMatchObject({ started: true, value: { ok: true, value: { scheduleState: 'scheduled' } } });
    expect(await harness.db.getAllAsync('SELECT enabled, schedule_state FROM reminders')).toEqual([{ enabled: 1, schedule_state: 'scheduled' }]);
    const receipt = await harness.db.getFirstAsync<{ outcome: string }>('SELECT outcome FROM command_receipts WHERE command_id = ?', [commandId]);
    expect(result.started && JSON.parse(receipt!.outcome)).toEqual(result.started && result.value);
    expect(scheduler.pending.size).toBe(1);
    owner.resume();
    expect(original.isCurrent()).toBe(false);
    expect(await original.run(async () => scheduler.schedule({} as never))).toEqual({ started: false });
    expect(scheduler.pending.size).toBe(1);
  });

  it('joins a directly admitted transaction and retains its executor after retirement', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const entered = held<void>();
    const release = held<void>();
    const write = owner.core.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      entered.resolve();
      await release.promise;
      return tx.getFirstAsync<{ icloud_sync_enabled: number }>('SELECT icloud_sync_enabled FROM app_settings');
    });
    await entered.promise;
    let joined = false;
    const joining = owner.suspend().then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    release.resolve();
    expect(await write).toEqual({ icloud_sync_enabled: 1 });
    await joining;
    expect(await harness.db.getFirstAsync('SELECT icloud_sync_enabled FROM app_settings')).toEqual({ icloud_sync_enabled: 1 });
  });

  it('joins a failed transaction without replacing its failure or leaving partial rows', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const entered = held<void>();
    const release = held<void>();
    const reason = new Error('transaction rejected');
    const work = owner.core.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync('UPDATE app_settings SET icloud_sync_enabled = 1');
      entered.resolve();
      await release.promise;
      throw reason;
    });
    const rejected = expect(work).rejects.toBe(reason);
    await entered.promise;
    const joining = owner.suspend();
    release.resolve();
    await rejected;
    await joining;
    expect(await harness.db.getFirstAsync('SELECT icloud_sync_enabled FROM app_settings')).toEqual({ icloud_sync_enabled: 0 });
    owner.resume();
    expect(await owner.core.db.withTransactionAsync(tx => tx.getAllAsync('SELECT id FROM boards'))).toEqual([]);
  });

  it('notifies synchronously once per transition and refuses premature resume', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const observed: boolean[] = [];
    const remove = owner.subscribe(() => { observed.push(owner.getScope().active); });
    const release = held<void>();
    const work = owner.getScope().run(() => release.promise);
    owner.resume();
    const joining = owner.suspend();
    expect(observed).toEqual([false]);
    expect(owner.suspend()).toBe(joining);
    expect(() => owner.resume()).toThrow('still running');
    release.resolve();
    await work;
    await joining;
    owner.resume();
    owner.resume();
    expect(observed).toEqual([false, true]);
    remove();
    await owner.suspend();
    expect(observed).toEqual([false, true]);
  });

  it('forwards every SQL method while active and never lets a UI core close its runtime database', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    await owner.core.db.execAsync('CREATE TABLE operation_probe (value INTEGER)');
    expect(await owner.core.db.runAsync('INSERT INTO operation_probe VALUES (?)', [7])).toEqual({ changes: 1 });
    expect(await owner.core.db.getFirstAsync('SELECT value FROM operation_probe')).toEqual({ value: 7 });
    expect(await owner.core.db.getAllAsync('SELECT value FROM operation_probe')).toEqual([{ value: 7 }]);
    await expect(owner.core.db.closeAsync()).rejects.toThrow('owned by its runtime');
    await owner.suspend();
    const operations = [
      () => owner.core.db.execAsync('DROP TABLE operation_probe'),
      () => owner.core.db.runAsync('INSERT INTO operation_probe VALUES (8)'),
      () => owner.core.db.getFirstAsync('SELECT * FROM operation_probe'),
      () => owner.core.db.withTransactionAsync(async () => 1),
      () => owner.core.db.withExclusiveTransactionAsync(async () => 2),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow('inactive');
    await expect(owner.core.db.closeAsync()).rejects.toThrow('owned by its runtime');
    expect(await harness.db.getAllAsync('SELECT value FROM operation_probe')).toEqual([{ value: 7 }]);
  });

  it('preserves synchronous callback failures while suspension still settles', async () => {
    const owner = createOperationOwner(harness.deps, { kind: 'sample-disabled' });
    const reason = new Error('synchronous rejection');
    await expect(owner.getScope().run(() => { throw reason; })).rejects.toBe(reason);
    await owner.suspend();
    owner.resume();
    expect(await owner.getScope().run(async () => 4)).toEqual({ started: true, value: 4 });
  });
});
