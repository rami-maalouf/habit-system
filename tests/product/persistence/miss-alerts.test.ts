import { archiveBoard, createBoard, createCheckIn, deleteBoard, removeCheckIn, restoreBoard } from '@/core/domain/commands';
import type { BoardId, LogicalDate } from '@/core/domain/ids';
import { missAlertIdentifier, planMissAlertPair } from '@/core/domain/miss-alerts';
import type { MissAlertPair } from '@/core/domain/ports';
import { readEffectiveMissAlertDates, readMissAlertBoards, readMissAlertPeriods, readMissAlertRows,
  readUnresolvedMissAlertRows, replaceMissAlertRow, type MissAlertRow } from '@/core/persistence/repositories/miss-alerts';
import { createTestHarness, type TestHarness } from '../helpers/test-db';

const day = (value: string) => value as LogicalDate;
const missingId = 'aaaaaaaa-0000-4000-8000-000000000099' as BoardId;
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); h.clock.utcMs = Date.parse('2026-09-01T16:00:00Z'); });
afterEach(async () => { jest.restoreAllMocks(); await h.db.closeAsync(); });
async function board(kind: 'daily' | 'count' = 'daily') {
  const result = await createBoard(h.deps, { commandId: h.ids.nextCommandId(), kind, title: 'Reading', symbol: 'book.fill',
    accentHex: '#70A7FF', usesTintedBackground: false, tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}
const pairFor = (boardId: BoardId, date = '2026-09-08'): MissAlertPair => ({ boardId, secondMissedDate: day(date) });
const rowFor = (pair: MissAlertPair): MissAlertRow => ({ ...pair, status: 'pending', nativeIdentifier: null });
const write = (old: MissAlertRow | null, next: MissAlertRow) => h.db.withExclusiveTransactionAsync(tx => replaceMissAlertRow(tx, old, next));
async function productRows() {
  return Promise.all(['boards', 'check_ins', 'habit_actions', 'coin_ledger', 'app_settings', 'mutation_outbox',
    'command_receipts', 'board_activity_periods', 'widget_board_rows'].map(table => h.db.getAllAsync(`SELECT * FROM ${table} ORDER BY rowid`)));
}

it('conditionally persists one pair, reports actual changes and preserves unrelated product bytes', async () => {
  const pair = pairFor(await board()); const pending = rowFor(pair);
  const reserved: MissAlertRow = { ...pair, status: 'pending', nativeIdentifier: missAlertIdentifier(pair) };
  const scheduled: MissAlertRow = { ...pair, status: 'scheduled', nativeIdentifier: missAlertIdentifier(pair) };
  const before = await productRows();
  expect(await write(null, pending)).toBe(true);
  expect(await write(null, pending)).toBe(false);
  expect(await write(pending, reserved)).toBe(true);
  expect(await write(reserved, scheduled)).toBe(true);
  expect(await write(reserved, { ...reserved, status: 'error' })).toBe(false);
  expect(await write(scheduled, scheduled)).toBe(false);
  expect(await readMissAlertRows(h.db, [pair, pair])).toEqual([scheduled]);
  expect(await productRows()).toEqual(before);
});
it('reads exact pair tuples, every permitted state and only unresolved consumed rows', async () => {
  const a = await board(); const b = await board();
  const rows: MissAlertRow[] = [
    rowFor(pairFor(a)), { ...pairFor(b, '2026-09-07'), status: 'denied', nativeIdentifier: null },
    { ...pairFor(a, '2026-09-06'), status: 'error', nativeIdentifier: null },
    { ...pairFor(a, '2026-09-05'), status: 'pending', nativeIdentifier: missAlertIdentifier(pairFor(a, '2026-09-05')) },
    { ...pairFor(a, '2026-09-04'), status: 'error', nativeIdentifier: missAlertIdentifier(pairFor(a, '2026-09-04')) },
    { ...pairFor(a, '2026-09-03'), status: 'scheduled', nativeIdentifier: missAlertIdentifier(pairFor(a, '2026-09-03')) },
  ];
  for (const row of rows) await write(null, row);
  await write(null, rowFor(pairFor(a, '2026-09-07')));
  await write(null, rowFor(pairFor(b)));
  expect(await readMissAlertRows(h.db, [rows[0], rows[1]])).toEqual([rows[0], rows[1]]);
  expect(await readMissAlertRows(h.db, rows)).toEqual([rows[5], rows[4], rows[3], rows[2], rows[0], rows[1]]);
  expect(await readUnresolvedMissAlertRows(h.db)).toEqual([rows[4], rows[3]]);
});
it('returns active Daily boards and exact inactive identities needed for cancellation', async () => {
  const live = await board(); const count = await board('count'); const archived = await board(); const deleted = await board();
  expect((await archiveBoard(h.deps, { boardId: archived, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  expect((await deleteBoard(h.deps, { boardId: deleted, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  await h.db.runAsync('UPDATE boards SET title = ? WHERE id = ?', ['', deleted]);
  expect((await readMissAlertBoards(h.db, [])).map(row => row.id)).toEqual([live]);
  const rows = await readMissAlertBoards(h.db, [count, archived, deleted, missingId, count]);
  expect(rows.map(row => row.id)).toEqual([live, count, archived, deleted]);
  expect(rows[2].archivedAt).not.toBeNull(); expect(rows[3]).toMatchObject({ title: '', deletedAt: h.clock.utcMs });
});
it('keeps date-based periods and exact effective presence without notes or speculative raw checks', async () => {
  const a = await board(); const b = await board('count');
  h.clock.utcMs = Date.parse('2026-09-09T12:00:00Z');
  const checked = await createCheckIn(h.deps, { boardId: a, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: day('2026-09-07'), note: 'private note' });
  if (!checked.ok) throw new Error(checked.error.message);
  expect((await createCheckIn(h.deps, { boardId: b, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: day('2026-09-08') })).ok).toBe(true);
  expect((await createCheckIn(h.deps, { boardId: b, commandId: h.ids.nextCommandId(), source: 'app', logicalDate: day('2026-09-08') })).ok).toBe(true);
  const requested = [a, b].flatMap(boardId => ['2026-09-07', '2026-09-08'].map(logicalDate => ({ boardId, logicalDate: day(logicalDate) })));
  expect(await readEffectiveMissAlertDates(h.db, [requested[0], requested[3], requested[3]])).toEqual([requested[0], requested[3]]);
  expect(await readEffectiveMissAlertDates(h.db, [requested[1], requested[2]])).toEqual([]);
  await h.db.runAsync('UPDATE check_ins SET state_suppressed = 1 WHERE id = ?', [checked.value.checkInId]);
  expect(await readEffectiveMissAlertDates(h.db, requested)).toEqual([requested[3]]);
  const before = await productRows();
  await h.db.withTransactionAsync(async tx => {
    const boards = await readMissAlertBoards(tx, []); const periods = await readMissAlertPeriods(tx, [a, a, missingId]);
    const dates = await readEffectiveMissAlertDates(tx, requested);
    expect(periods).toEqual([{ boardId: a, periods: [{ startDate: '2026-09-01', endDate: null }] }, { boardId: missingId, periods: [] }]);
    expect(planMissAlertPair({ board: boards[0], periods: periods[0].periods,
      effectiveCheckedDates: dates.filter(row => row.boardId === a).map(row => row.logicalDate) },
    { nowUtcMs: h.clock.utcMs, timeZoneId: h.clock.zone, foreground: true })).toMatchObject(pairFor(a));
  });
  expect(await productRows()).toEqual(before);
  await h.db.runAsync('UPDATE check_ins SET state_suppressed = 0 WHERE id = ?', [checked.value.checkInId]);
  expect((await removeCheckIn(h.deps, { checkInId: checked.value.checkInId, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  expect(await readEffectiveMissAlertDates(h.db, requested)).toEqual([requested[3]]);
});
it('keeps same-day archive/restore endpoints, reversed periods, and excludes tombstoned periods', async () => {
  const a = await board(); h.clock.advanceDays(2);
  expect((await archiveBoard(h.deps, { boardId: a, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  expect(await readMissAlertPeriods(h.db, [a])).toEqual([{ boardId: a, periods: [{ startDate: '2026-09-01', endDate: '2026-09-03' }] }]);
  expect((await restoreBoard(h.deps, { boardId: a, commandId: h.ids.nextCommandId() })).ok).toBe(true);
  await h.db.runAsync("INSERT INTO board_activity_periods(board_id,start_date,end_date,mutation_stamp,deleted_at) VALUES (?,?,?,?,?)",
    [a, '2026-09-05', '2026-09-04', 'unused', null]);
  await h.db.runAsync("INSERT INTO board_activity_periods(board_id,start_date,end_date,mutation_stamp,deleted_at) VALUES (?,?,?,?,?)",
    [a, '2026-09-20', null, 'unused', 0]);
  expect(await readMissAlertPeriods(h.db, [a])).toEqual([{ boardId: a, periods: [
    { startDate: '2026-09-01', endDate: null },
    { startDate: '2026-09-05', endDate: '2026-09-04' },
  ] }]);
});
it('does not hydrate history for empty requested scopes and only binds projected keys', async () => {
  const a = await board(); const pair = pairFor(a); await write(null, rowFor(pair));
  const spy = jest.spyOn(h.db, 'getAllAsync');
  expect(await readMissAlertRows(h.db, [])).toEqual([]);
  expect(await readMissAlertPeriods(h.db, [])).toEqual([]);
  expect(await readEffectiveMissAlertDates(h.db, [])).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
  const augmented = { ...pair, note: 'do not bind this', proof: 'private' };
  await readMissAlertRows(h.db, [augmented]);
  expect(JSON.stringify(spy.mock.calls)).not.toContain('private');
  expect(JSON.stringify(spy.mock.calls)).not.toContain('do not bind this');
});
it('rolls back pair writes and does not overwrite another identity or a missing row', async () => {
  const pair = pairFor(await board()); const pending = rowFor(pair);
  const failure = new Error('transaction failed');
  await expect(h.db.withExclusiveTransactionAsync(async tx => { await replaceMissAlertRow(tx, null, pending); throw failure; })).rejects.toBe(failure);
  expect(await readMissAlertRows(h.db, [pair])).toEqual([]);
  expect(await write(pending, { ...pair, status: 'denied', nativeIdentifier: null })).toBe(false);
  await expect(write(pending, rowFor(pairFor(pair.boardId, '2026-09-07')))).rejects.toThrow('invalid');
});
it('fails stored integrity rather than returning a malformed pair or consumed identifier', async () => {
  const pair = pairFor(await board()); await write(null, rowFor(pair));
  await h.db.runAsync('UPDATE miss_alerts SET native_identifier = ? WHERE board_id = ?', ['wrong-private-id', pair.boardId]);
  await expect(readMissAlertRows(h.db, [pair])).rejects.toThrow('invalid');
  await expect(readUnresolvedMissAlertRows(h.db)).rejects.toThrow('invalid');
});
it('rejects malformed stored dates and statuses even when the selected identity is known', async () => {
  const pair = pairFor(await board());
  const reserved: MissAlertRow = { ...pair, status: 'pending', nativeIdentifier: missAlertIdentifier(pair) };
  await write(null, reserved);
  await h.db.runAsync('UPDATE miss_alerts SET second_missed_date = ?', ['2026-02-30']);
  await expect(readUnresolvedMissAlertRows(h.db)).rejects.toThrow('invalid');
  await h.db.runAsync('UPDATE miss_alerts SET second_missed_date = ?', [pair.secondMissedDate]);
  await h.db.execAsync('PRAGMA ignore_check_constraints = ON');
  for (const [status, nativeId] of [['invented', null], ['scheduled', null], ['denied', reserved.nativeIdentifier]]) {
    await h.db.runAsync('UPDATE miss_alerts SET status = ?, native_identifier = ?', [status, nativeId]);
    await expect(readMissAlertRows(h.db, [pair])).rejects.toThrow('invalid');
  }
});
it.each(['start', 'archive', 'title'])('rejects corrupt selected board %s without returning its private value', async field => {
  const id = await board();
  if (field === 'start') await h.db.runAsync('UPDATE boards SET start_of_day_minute = 17 WHERE id = ?', [id]);
  if (field === 'archive') await h.db.runAsync('UPDATE boards SET archived_at = ? WHERE id = ?', ['private-value', id]);
  if (field === 'title') await h.db.runAsync("UPDATE boards SET title = X'FF' WHERE id = ?", [id]);
  await expect(readMissAlertBoards(h.db, [id])).rejects.toThrow('Stored miss alert data is invalid.');
});
it('rejects corrupt period endpoints but retains valid empty and reversed ranges', async () => {
  const id = await board();
  for (const value of ['2026-02-30', '2026-09-07\n']) {
    await h.db.runAsync('UPDATE board_activity_periods SET end_date = ? WHERE board_id = ?', [value, id]);
    await expect(readMissAlertPeriods(h.db, [id])).rejects.toThrow('invalid');
  }
});
it('refuses malformed caller rows before writing and distinct identity substitution', async () => {
  const a = pairFor(await board()); const b = pairFor(await board());
  await expect(write(rowFor(a), rowFor(b))).rejects.toThrow('invalid');
  await expect(write(null, { ...rowFor(a), secondMissedDate: day('invalid') })).rejects.toThrow('invalid');
  await expect(write(null, { ...rowFor(a), status: 'scheduled' } as MissAlertRow)).rejects.toThrow('invalid');
  expect(await readMissAlertRows(h.db, [a, b])).toEqual([]);
});
it('reads only explicit board identities when requalifying an acquired pair', async () => {
  const a = await board(); const b = await board();
  expect((await readMissAlertBoards(h.db, [a], false)).map(row => row.id)).toEqual([a]);
  expect(await readMissAlertBoards(h.db, [], false)).toEqual([]);
  expect((await readMissAlertBoards(h.db, [a])).map(row => row.id)).toEqual([a, b]);
});
