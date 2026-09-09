import { act } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as commands from '@/core/domain/commands';
import { createReward } from '@/core/domain/reward-commands';
import { err } from '@/core/domain/result';
import * as parsers from '@/core/export/import-parsers';
import { getExportSnapshot, serializeExport } from '@/core/export/serialize';
import { getAppSettings, listActiveBoards } from '@/core/domain/queries';

import { dataTransferMock, resetDataTransferMock } from '../../../src/testing/data-transfer.mock';
import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';
import { createTestHarness } from '../helpers/test-db';

async function core() {
  const opened = await getProductCore();
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function backup() {
  const donor = await createTestHarness();
  try {
    const board = await commands.createBoard(donor.deps, {
      commandId: donor.ids.nextCommandId(), title: 'Morning walk', kind: 'daily',
      symbol: 'star.fill', accentHex: '#78D98B', usesTintedBackground: false,
      tracksAmount: false, tracksTime: false, startOfDayMinute: 0, metricsEnabled: true,
      earnsCoins: true, coinCapPerDay: 1,
    });
    if (!board.ok) throw new Error(board.error.message);
    expect(await commands.createCheckIn(donor.deps, {
      commandId: donor.ids.nextCommandId(), boardId: board.value.boardId, source: 'app',
    })).toMatchObject({ ok: true });
    expect(await createReward(donor.deps, {
      commandId: donor.ids.nextCommandId(), title: 'Coffee break', costCoins: 1,
      symbol: 'star.fill', accentHex: '#78D98B',
    })).toMatchObject({ ok: true });
    expect(await commands.setAnchorPresetMinute(donor.deps, {
      commandId: donor.ids.nextCommandId(), preset: 'wake', minute: 360,
    })).toMatchObject({ ok: true });
    const result = await getExportSnapshot(donor.deps, {
      databaseSchemaVersion: 11, appVersion: 'test', buildVersion: 'test', locale: 'en-US',
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.exportVersion).toBe(2);
    return serializeExport(result.value);
  } finally { await donor.db.closeAsync(); }
}
async function choose(contents: string) {
  dataTransferMock.nextPick = { name: 'habit-backup.json', contents };
  await press('import-own');
  expect(await screen.findByTestId('import-preview-counts')).toHaveTextContent('1 board, 1 check-in, 1 reward.');
}
async function openImport(contents: string) {
  renderRouter('src/app', { initialUrl: '/settings' });
  await screen.findByTestId('settings-import');
  await press('settings-import');
  await choose(contents);
}
async function savedHistory() {
  const { db } = await core();
  return Promise.all(['boards', 'check_ins', 'rewards', 'habit_actions', 'coin_ledger', 'mutation_outbox']
    .map(table => db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`)));
}
async function restoreSnapshot() {
  const { db } = await core();
  const rows: Record<string, Record<string, unknown>[]> = Object.fromEntries(await Promise.all([
    ['boards', 'id'], ['check_ins', 'id'], ['board_activity_periods', 'id'], ['reminders', 'id'],
    ['rewards', 'id'], ['habit_actions', 'id'], ['coin_ledger', 'id'], ['mutation_outbox', 'id'],
    ['command_receipts', 'command_id'], ['app_settings', 'id'],
  ].map(async ([table, order]) => [table, await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order}`)])));
  // route focus may add the inherited reminder no-op receipt, without changing imported state.
  rows.command_receipts = rows.command_receipts.filter(row => row.outcome !== '{"ok":true,"value":{"updated":0}}');
  return rows;
}

describe('routed version two restore', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); resetDataTransferMock(); });

  it('previews rewards and restores history and fresh anchor times without earning again on repeat', async () => {
    const contents = await backup();
    await openImport(contents);
    expect(screen.getByTestId('import-preview')).toHaveTextContent('Existing settings are kept. An empty app can also restore the saved anchor times.', { exact: false });
    await press('import-confirm');
    expect(await screen.findByTestId('import-summary')).toHaveTextContent('Added 1 board and 1 check-in.');
    expect(screen.getByTestId('import-reward-summary')).toHaveTextContent('Added 1 reward.');
    expect(screen.getByTestId('import-settings-summary')).toHaveTextContent('Anchor times restored.');
    const current = await core();
    expect(await getAppSettings(current)).toMatchObject({ ok: true, value: { wakeMinute: 360 } });
    expect(await current.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 1 });
    const first = await savedHistory();
    await press('import-again'); await choose(contents); await press('import-confirm');
    expect(await screen.findByTestId('import-reward-summary')).toHaveTextContent('Added 0 rewards. Skipped 1 reward (already present or invalid).');
    expect(screen.getByTestId('import-settings-summary')).toHaveTextContent('Existing settings kept.');
    expect(await savedHistory()).toEqual(first);
  });

  it('reports preserved destination settings after importing a backup with different anchor times', async () => {
    const current = await core();
    expect(await commands.setAnchorPresetMinute(current, {
      commandId: newCommandId(), preset: 'wake', minute: 480,
    })).toMatchObject({ ok: true });
    await openImport(await backup()); await press('import-confirm');
    expect(await screen.findByTestId('import-settings-summary')).toHaveTextContent('Existing settings kept.');
    expect(await getAppSettings(current)).toMatchObject({ ok: true, value: { wakeMinute: 480 } });
    expect(await listActiveBoards(current)).toMatchObject({ ok: true, value: [{ title: 'Morning walk' }] });
  });

  it('keeps the complete v2 request and original receipt after a lost response and route remount', async () => {
    const contents = await backup();
    const parsed = parsers.parseOwnExport(contents);
    if (!parsed.ok) throw new Error(parsed.error.message);
    jest.spyOn(parsers, 'parseOwnExport').mockReturnValueOnce(parsed);
    const actual = commands.importSnapshot;
    let original!: Awaited<ReturnType<typeof actual>>;
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      const result = await actual(...args);
      expect(result.ok).toBe(true);
      original = structuredClone(result);
      return err('database', 'The import response was interrupted. Try again.', { retryable: true });
    });
    await openImport(contents); await press('import-confirm');
    expect(await screen.findByTestId('import-error')).toHaveTextContent('interrupted', { exact: false });
    const submitted = structuredClone(submit.mock.calls[0][1]);
    const afterCommit = await restoreSnapshot();
    const originalDraft = parsed.value as unknown as {
      boards: { title: string; periods: { startDate: string }[] }[];
      rewards: { title: string }[]; settings: { value: { wakeMinute: number } };
      evidence: { sourceJson: string }; skipped: { rewards: number };
    };
    originalDraft.boards[0].title = 'Changed after submit';
    originalDraft.boards[0].periods[0].startDate = '1900-01-01';
    originalDraft.rewards[0].title = 'Changed reward';
    originalDraft.settings.value.wakeMinute = 0;
    originalDraft.evidence.sourceJson = '{}';
    originalDraft.skipped.rewards = 100;
    act(() => router.back()); await settle();
    await press('settings-import');
    expect(await screen.findByTestId('import-preview-counts')).toHaveTextContent('1 board, 1 check-in, 1 reward.');
    await press('import-confirm');
    expect(await screen.findByTestId('import-settings-summary')).toHaveTextContent('Anchor times restored.');
    expect(submit.mock.calls[1][1]).toEqual(submitted);
    const delivered = await submit.mock.results[1].value;
    expect(delivered).toEqual(original);
    expect(await restoreSnapshot()).toEqual(afterCommit);
    if (!delivered.ok || !delivered.value.v2) throw new Error('missing version two summary');
    delivered.value.v2.settings = 'invalid';
    delivered.value.v2.immutable.pending = 100;
    act(() => router.back()); await settle(); await press('settings-import');
    expect(await screen.findByTestId('import-settings-summary')).toHaveTextContent('Anchor times restored.');
    expect(screen.queryByTestId('import-history-remaining')).toBeNull();
  });

  it('restores unchanged bytes shared by the export screen into a separate fresh app', async () => {
    const parsed = parsers.parseOwnExport(await backup());
    if (!parsed.ok) throw new Error(parsed.error.message);
    const source = await core();
    expect(await commands.importSnapshot(source, { commandId: newCommandId(), draft: parsed.value })).toMatchObject({ ok: true });
    const history = await Promise.all(['habit_actions', 'coin_ledger'].map(table => source.db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`)));
    const exported = renderRouter('src/app', { initialUrl: '/settings/export' });
    await screen.findByTestId('export-start'); await press('export-start');
    expect(await screen.findByTestId('export-shared')).toBeOnTheScreen();
    expect(dataTransferMock.sharedFiles).toHaveLength(1);
    const contents = dataTransferMock.sharedFiles[0].contents;
    expect(JSON.parse(contents)).toMatchObject({ exportVersion: 2, settings: { wakeMinute: 360 } });
    exported.unmount(); resetProductCoreForTests();
    await openImport(contents); await press('import-confirm');
    expect(await screen.findByTestId('import-done')).toBeOnTheScreen();
    const restored = await core();
    expect(await Promise.all(['habit_actions', 'coin_ledger'].map(table => restored.db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`)))).toEqual(history);
    expect(await restored.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 1 });
  });

  it.each([
    ['unchanged', 420, 'Anchor times already match.'],
    ['invalid', 1, 'Settings could not be restored. Existing settings kept.'],
  ])('reports %s anchor settings while unrelated valid history restores', async (_kind, minute, expected) => {
    const file = JSON.parse(await backup()); file.settings.wakeMinute = minute;
    await openImport(JSON.stringify(file)); await press('import-confirm');
    expect(await screen.findByTestId('import-settings-summary')).toHaveTextContent(expected as string);
    const current = await core();
    expect(await getAppSettings(current)).toMatchObject({ ok: true, value: { wakeMinute: 420 } });
    expect(await current.db.getFirstAsync('SELECT SUM(delta) AS balance FROM coin_ledger')).toEqual({ balance: 1 });
  });

  it('reports retained history as device totals without exposing invalid source fields', async () => {
    const file = JSON.parse(await backup());
    file.habitActions[0].extra = 'private invalid source sentinel';
    await openImport(JSON.stringify(file)); await press('import-confirm');
    const expected = 'History on this device still needs attention: 1 waiting for related records, 0 waiting to be processed, 1 needing review.';
    expect(await screen.findByTestId('import-history-remaining')).toHaveTextContent(expected);
    expect(screen.queryByText(/private invalid source sentinel/)).toBeNull();
    await press('import-again');
    const empty = { ...file, boards: [], checkIns: [], reminders: [], rewards: [], habitActions: [], coinLedger: [] };
    dataTransferMock.nextPick = { name: 'empty-backup.json', contents: JSON.stringify(empty) };
    await press('import-own'); await press('import-confirm');
    expect(await screen.findByTestId('import-history-remaining')).toHaveTextContent(expected);
    expect(screen.getByTestId('import-summary')).toHaveTextContent('Added 0 boards and 0 check-ins.');
  });

  it('rejects an incomplete v2 file before an import attempt is allocated', async () => {
    const file = JSON.parse(await backup()); delete file.coinLedger;
    const submit = jest.spyOn(commands, 'importSnapshot');
    dataTransferMock.nextPick = { name: 'incomplete-backup.json', contents: JSON.stringify(file) };
    renderRouter('src/app', { initialUrl: '/settings/import' });
    await screen.findByTestId('import-own'); await press('import-own');
    expect(await screen.findByTestId('import-error')).toBeOnTheScreen();
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(await savedHistory()).toEqual([[], [], [], [], [], []]);
  });
});
