import fixture from '@/core/automations/fixtures/check-coins.json';
import { COIN_POLICY_BYTES, COIN_RECORD_BYTES } from '@/core/domain/coin-policy';
import { baselineAction, validateHabitAction } from '@/core/domain/habit-actions';
import type { HabitAction, HabitActionKind } from '@/core/domain/habit-actions';
import { appendHabitAction, listHabitActions } from '@/core/persistence/repositories/habit-actions';

import { createTestHarness, type TestHarness } from '../helpers/test-db';

const original = fixture.cases[0].actions[0] as HabitAction;

describe('persisted immutable action policies', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  it.each(['check', 'uncheck', 'move_out', 'move_in', 'policy'] as HabitActionKind[])(
    'retains canonical policy on a live %s with immutable replay', async kind => {
      const action = { ...original, kind, checkInId: kind === 'policy' ? null : original.checkInId };
      expect(validateHabitAction(action)).toEqual({ ok: true, value: action });
      expect(await appendHabitAction(h.db, action)).toBe(true);
      expect(await appendHabitAction(h.db, action)).toBe(false);
      expect(await listHabitActions(h.db, action.boardId, action.logicalDate)).toEqual([action]);
      await expect(appendHabitAction(h.db, { ...action, policyJson: action.policyJson!.replace('true', 'false') }))
        .rejects.toThrow('Immutable');
      expect(await listHabitActions(h.db, action.boardId, action.logicalDate)).toEqual([action]);
    },
  );

  it('preserves legacy null policies and rejects assigning a policy to a synthetic baseline', async () => {
    const baseline = await baselineAction({ id: original.checkInId!, boardId: original.boardId,
      logicalDate: original.logicalDate }, h.deps.hashing);
    await appendHabitAction(h.db, baseline);
    await appendHabitAction(h.db, { ...original, policyJson: null });
    await expect(appendHabitAction(h.db, { ...baseline, policyJson: original.policyJson })).rejects.toThrow('Invalid');
    expect(await listHabitActions(h.db, original.boardId, original.logicalDate)).toEqual([baseline, { ...original, policyJson: null }]);
  });

  it.each(['{}', '[]', 'null', 'invalid', ` ${original.policyJson}`, original.policyJson!.replace('"version":1', '"version":2')])(
    'rejects malformed or noncanonical policy before insertion: %s', async policyJson => {
      await expect(appendHabitAction(h.db, { ...original, policyJson })).rejects.toThrow('Invalid');
      expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
    },
  );

  it('rejects policy-bearing negative-zero timestamps before SQLite can normalize them', async () => {
    await expect(appendHabitAction(h.db, { ...original, createdAt: -0 })).rejects.toThrow('Invalid');
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
  });

  it.each([
    { ...original, policyJson: 'x'.repeat(COIN_POLICY_BYTES + 1) },
    { ...original, mutationStamp: `00000000000001-00000-${'x'.repeat(COIN_RECORD_BYTES)}` },
  ])('reports a bounded record capacity failure and inserts nothing', async action => {
    expect(validateHabitAction(action)).toMatchObject({ ok: false, error: { code: 'capacity', retryable: true } });
    await expect(appendHabitAction(h.db, action)).rejects.toMatchObject({ reason: 'size' });
    expect(await h.db.getAllAsync('SELECT * FROM habit_actions')).toEqual([]);
  });
});
