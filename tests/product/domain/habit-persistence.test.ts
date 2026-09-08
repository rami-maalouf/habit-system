import { createBoard, updateBoard } from '@/core/domain/commands';
import type { Board } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';
import { readWidgetRows, rebuildWidgetRows } from '@/core/persistence/projections/widget-rows';
import { getBoardById, insertBoard, listActiveBoards, listArchivedBoards, updateBoardRow } from '@/core/persistence/repositories/boards';
import { getSettings, saveAnchorPresetMinutes } from '@/core/persistence/repositories/support';

import { createTestHarness } from '../helpers/test-db';

const defaults = {
  kind: 'count', anchorRelation: null, anchorKind: null, anchorBoardId: null,
  anchorPreset: null, anchorText: null, usualTimeMinute: null,
  requiredInStack: true, earnsCoins: false, coinCapPerDay: 1,
};

describe('habit field persistence', () => {
  it('hydrates default fields from a compatibility command without changing count options', async () => {
    const { db, deps, ids } = await createTestHarness();
    try {
      const result = await createBoard(deps, {
        commandId: ids.nextCommandId(), title: 'count habit', symbol: 'star.fill', accentHex: '#70A7FF',
        usesTintedBackground: true, tracksAmount: true, amountUnit: 'minutes', quickAmount: 2.5,
        tracksTime: true, startOfDayMinute: 240, metricsEnabled: true,
      });
      expect(result.ok).toBe(true);
      expect((await listActiveBoards(db))[0]).toMatchObject({ ...defaults, tracksAmount: true, tracksTime: true, quickAmount: 2.5 });
      expect((await readWidgetRows(db))[0]).toMatchObject({ kind: 'count' });
    } finally {
      await db.closeAsync();
    }
  });

  it('round-trips each anchor form, habit options, and widget kind through real repositories', async () => {
    const { db, deps, ids, clock } = await createTestHarness();
    try {
      await createBoard(deps, { commandId: ids.nextCommandId(), title: 'parent', symbol: 'star.fill', accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
      const parent = (await listActiveBoards(db))[0];
      const daily: Board = {
        ...parent, id: ids.uuid() as BoardId, title: 'daily', orderKey: 'j', kind: 'daily',
        anchorKind: 'board', anchorRelation: 'after', anchorBoardId: parent.id,
        anchorPreset: null, anchorText: null, usualTimeMinute: 1425,
        requiredInStack: false, earnsCoins: true, coinCapPerDay: 10,
      };
      await insertBoard(db, daily);
      expect(await getBoardById(db, daily.id)).toEqual(daily);
      expect((await listActiveBoards(db))[1]).toEqual(daily);
      await rebuildWidgetRows(db, clock.utcMs, clock.zone);
      expect(await readWidgetRows(db)).toEqual([
        expect.objectContaining({ boardId: parent.id, kind: 'count' }),
        expect.objectContaining({ boardId: daily.id, kind: 'daily' }),
      ]);
      const text: Board = { ...daily, anchorKind: 'text', anchorRelation: 'before', anchorBoardId: null, anchorText: 'after lunch café', usualTimeMinute: 0, requiredInStack: true, earnsCoins: false, coinCapPerDay: 1 };
      await updateBoardRow(db, text);
      expect(await getBoardById(db, daily.id)).toEqual(text);
      expect((await updateBoard(deps, { ...text, commandId: ids.nextCommandId(), boardId: text.id, expectedMutationStamp: text.mutationStamp, title: 'renamed daily' })).ok).toBe(true);
      expect(await getBoardById(db, daily.id)).toMatchObject({ ...text, title: 'renamed daily', mutationStamp: expect.any(String) });
      const preset: Board = { ...text, anchorKind: 'preset', anchorText: null, anchorPreset: 'wake', requiredInStack: false, earnsCoins: true, archivedAt: clock.utcMs };
      await updateBoardRow(db, preset);
      expect((await listArchivedBoards(db))[0]).toEqual(preset);
      const cleared: Board = { ...preset, ...defaults, kind: 'count', archivedAt: null };
      await updateBoardRow(db, cleared);
      expect(await getBoardById(db, daily.id)).toEqual(cleared);
    } finally {
      await db.closeAsync();
    }
  });

  it('hydrates and saves preset minutes together while retaining unrelated settings', async () => {
    const { db } = await createTestHarness();
    try {
      const before = await getSettings(db);
      expect(before).toMatchObject({ wakeMinute: 420, lunchMinute: 720, dinnerMinute: 1080, sleepMinute: 1380 });
      const changed = { wakeMinute: 0, lunchMinute: 735, dinnerMinute: 1110, sleepMinute: 1425 };
      await saveAnchorPresetMinutes(db, changed, 'preset-stamp');
      expect(await getSettings(db)).toEqual({ ...before, ...changed });
      expect(await db.getFirstAsync('SELECT settings_mutation_stamp FROM app_settings')).toEqual({ settings_mutation_stamp: 'preset-stamp' });
    } finally {
      await db.closeAsync();
    }
  });
});
