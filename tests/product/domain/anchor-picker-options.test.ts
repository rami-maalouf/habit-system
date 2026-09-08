import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveBoard, createBoard, deleteBoard, setAnchorPresetMinute } from '@/core/domain/commands';
import { getAnchorPickerOptions } from '@/core/domain/queries';

import { createTestHarness, NodeSqlDatabase, type TestHarness } from '../helpers/test-db';

const fields = {
  title: 'Anchor choice', symbol: 'star.fill', accentHex: '#70A7FF',
  usesTintedBackground: false, tracksAmount: false, tracksTime: false,
  startOfDayMinute: 0, metricsEnabled: true,
};

describe('anchor picker snapshot', () => {
  let h: TestHarness;
  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(async () => { await h.db.closeAsync(); });

  async function board(title: string) {
    const result = await createBoard(h.deps, { ...fields, title, commandId: h.ids.nextCommandId() });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.boardId;
  }

  it('returns active and archived choices in home order with id ties and current preset values', async () => {
    const a = await board('Active');
    const b = await board('Archived');
    const deleted = await board('Deleted');
    await archiveBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: b });
    await deleteBoard(h.deps, { commandId: h.ids.nextCommandId(), boardId: deleted });
    await h.db.runAsync('UPDATE boards SET order_key = ? WHERE id IN (?, ?)', ['m0', a, b]);
    await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 0 });
    await setAnchorPresetMinute(h.deps, { commandId: h.ids.nextCommandId(), preset: 'sleep', minute: 1425 });
    const before = await h.db.getAllAsync('SELECT * FROM app_settings');
    const outbox = await h.db.getAllAsync('SELECT * FROM mutation_outbox');
    const receipts = await h.db.getAllAsync('SELECT * FROM command_receipts');
    const result = await getAnchorPickerOptions(h.deps);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.boards.map(({ id, title, archivedAt }) => ({ id, title, archivedAt }))).toEqual([
      { id: a, title: 'Active', archivedAt: null }, { id: b, title: 'Archived', archivedAt: h.clock.utcMs },
    ]);
    expect(result.value.presetMinutes).toEqual({ wake: 0, lunch: 720, dinner: 1080, sleep: 1425 });
    expect(await h.db.getAllAsync('SELECT * FROM app_settings')).toEqual(before);
    expect(await h.db.getAllAsync('SELECT * FROM mutation_outbox')).toEqual(outbox);
    expect(await h.db.getAllAsync('SELECT * FROM command_receipts')).toEqual(receipts);
  });

  it('returns saved presets when no habit choices exist and fails without inventing missing settings', async () => {
    expect(await getAnchorPickerOptions(h.deps)).toEqual({ ok: true, value: {
      boards: [], presetMinutes: { wake: 420, lunch: 720, dinner: 1080, sleep: 1380 },
    } });
    await h.db.runAsync('DELETE FROM app_settings');
    expect(await getAnchorPickerOptions(h.deps)).toMatchObject({ ok: false, error: { code: 'database', retryable: true } });
  });

  it('keeps choices and preset times in one snapshot while another connection commits changes', async () => {
    const id = await board('Concurrent choice');
    const directory = mkdtempSync(join(tmpdir(), 'habit-anchor-query-'));
    const path = join(directory, 'snapshot.sqlite');
    await h.db.runAsync('VACUUM INTO ?', [path]);
    const reader = new NodeSqlDatabase(path);
    const writer = new NodeSqlDatabase(path);
    try {
      await reader.execAsync('PRAGMA journal_mode = WAL');
      const original = reader.getFirstAsync.bind(reader);
      const intercepted = jest.spyOn(reader, 'getFirstAsync').mockImplementationOnce(async (sql, params) => {
        const row = await original(sql, params);
        const deps = { ...h.deps, db: writer };
        expect((await setAnchorPresetMinute(deps, { commandId: h.ids.nextCommandId(), preset: 'wake', minute: 450 })).ok).toBe(true);
        expect((await archiveBoard(deps, { commandId: h.ids.nextCommandId(), boardId: id })).ok).toBe(true);
        return row;
      });
      const snapshot = await getAnchorPickerOptions({ db: reader, clock: h.clock });
      expect(snapshot).toMatchObject({ ok: true, value: { boards: [{ id, archivedAt: null }], presetMinutes: { wake: 420 } } });
      intercepted.mockRestore();
      expect(await getAnchorPickerOptions({ db: reader, clock: h.clock })).toMatchObject({ ok: true, value: {
        boards: [{ id, archivedAt: h.clock.utcMs }], presetMinutes: { wake: 450 },
      } });
    } finally {
      await reader.closeAsync();
      await writer.closeAsync();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
