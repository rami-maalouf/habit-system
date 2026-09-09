import { writeFileSync } from 'node:fs';
import { act } from '@testing-library/react-native';
import { router } from 'expo-router';

import * as commands from '@/core/domain/commands';
import * as parsers from '@/core/export/import-parsers';
import * as transfer from '@/platform/data-transfer';
import { err } from '@/core/domain/result';
import { ProductPressable } from '@/features/ui';

import { dataTransferMock, resetDataTransferMock } from '../../../src/testing/data-transfer.mock';
import { getProductCore, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

const CSV = `entity,board_id,board_name,board_amountKind,board_tracksCheckinTime,board_tracksPerformanceMetrics,board_defaultAmount,board_dayStartShiftSeconds,board_archivedAt,board_createdAt,checkin_id,checkin_boardId,checkin_amount,checkin_note,checkin_createdAt
Board,0C137BDE-BCB0-465B-8C9B-BE3E71774FA6,"imported habit",,false,true,,0.0,,2026-05-04T02:06:28Z,,,,,
Checkin,,,,,,,,,,D5EC18C1-F13A-4594-A4F5-9450BC6D6004,0C137BDE-BCB0-465B-8C9B-BE3E71774FA6,,first note,2026-05-04T15:17:39Z
Checkin,,,,,,,,,,3088B55B-6C39-4B43-B948-ABE97EFFFA53,0C137BDE-BCB0-465B-8C9B-BE3E71774FA6,,second note,2026-08-23T03:29:26Z
`;
const HOUSEKEEPING = '{"ok":true,"value":{"updated":0}}';
async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function snapshot(): Promise<Record<string, Record<string, unknown>[]>> {
  const { db } = await core();
  return Object.fromEntries(await Promise.all([
    ['boards', 'id'], ['check_ins', 'id'], ['habit_actions', 'id'], ['coin_ledger', 'id'],
    ['board_activity_periods', 'id'], ['mutation_outbox', 'id'], ['command_receipts', 'command_id'],
    ['app_settings', 'id'],
  ].map(async ([table, order]) => [table, await db.getAllAsync<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order}`)])));
}
function domainSnapshot(rows: Awaited<ReturnType<typeof snapshot>>) {
  // keep complete receipt rows in evidence; only the existing reminder no-op is outside the import oracle.
  return { ...rows, command_receipts: rows.command_receipts.filter(row => row.outcome !== HOUSEKEEPING) };
}
function evidence(name: string, value: unknown) {
  const prefix = process.env.T20_IMPORT_EVIDENCE_PREFIX;
  if (prefix) writeFileSync(`${prefix}-${name}.json`, JSON.stringify(value, null, 2));
}
async function press(id: string) { fireEvent.press(screen.getByTestId(id)); await settle(); }
async function chooseCsv() {
  dataTransferMock.nextPick = { name: 'ripples.csv', contents: CSV };
  await press('import-ripples');
  expect(await screen.findByTestId('import-preview-counts')).toHaveTextContent('1 board, 2 check-ins.');
}
async function openImport() {
  const rendered = renderRouter('src/app', { initialUrl: '/settings' });
  await screen.findByTestId('settings-import');
  await press('settings-import');
  await screen.findByTestId('import-ripples');
  return rendered;
}

describe('routed import command recovery', () => {
  beforeEach(() => { jest.restoreAllMocks(); resetProductCoreForTests(); resetDataTransferMock(); });

  it('retries the original committed CSV receipt after its success response is lost', async () => {
    const actual = commands.importSnapshot;
    let original!: Awaited<ReturnType<typeof actual>>;
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      original = await actual(...args);
      expect(original.ok).toBe(true);
      return err('database', 'The import response was interrupted. Retry the import.', { retryable: true });
    });
    await openImport(); await chooseCsv();
    const before = await snapshot();
    await press('import-confirm');
    expect(await screen.findByTestId('import-error')).toHaveTextContent('interrupted', { exact: false });
    const committed = await snapshot();
    expect(committed.boards).toHaveLength(1);
    expect(committed.check_ins).toHaveLength(2);
    expect(committed.habit_actions).toHaveLength(2);
    expect(committed.coin_ledger).toEqual([]);
    const firstInput = structuredClone(submit.mock.calls[0][1]);
    const receiptControl = await actual(await core(), firstInput);
    expect(receiptControl).toEqual(original);
    expect(await snapshot()).toEqual(committed);
    // the current screen uses its visible import button as the retry control.
    await press('import-confirm');
    expect(await screen.findByTestId('import-summary')).toHaveTextContent('Added 1 board and 2 check-ins.');
    const afterRetry = await snapshot();
    evidence('lost-response', { before, committed, afterRetry, firstInput, retryInput: submit.mock.calls[1][1],
      original, receiptControl, retryResult: await submit.mock.results[1].value });
    expect(submit.mock.calls[1][1]).toEqual(firstInput);
    expect(await submit.mock.results[1].value).toEqual(original);
    expect(domainSnapshot(afterRetry)).toEqual(domainSnapshot(committed));
  });

  it('admits only one queued confirmation before the importing view can render', async () => {
    const actual = commands.importSnapshot;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementation(async (...args) => {
      await gate;
      return actual(...args);
    });
    await openImport(); await chooseCsv();
    const before = await snapshot();
    const queued = screen.UNSAFE_getAllByType(ProductPressable)
      .find(button => button.props.testID === 'import-confirm')!.props.onPress;
    act(() => { queued(); queued(); });
    await settle();
    const dispatched = submit.mock.calls.map(call => structuredClone(call[1]));
    await act(async () => { release(); }); await settle();
    expect(await screen.findByTestId('import-done')).toBeOnTheScreen();
    const after = await snapshot();
    evidence('queued-confirmation', { before, after, dispatched });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(after.boards).toHaveLength(1);
    expect(after.check_ins).toHaveLength(2);
    expect(after.habit_actions).toHaveLength(2);
    expect(after.coin_ledger).toEqual([]);
  });

  it('keeps the submitted attempt reachable after leaving and reopening the import route', async () => {
    const actual = commands.importSnapshot;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      const result = await actual(...args);
      expect(result.ok).toBe(true);
      await gate;
      return err('database', 'The import response was interrupted. Retry the import.', { retryable: true });
    });
    await openImport(); await chooseCsv();
    await press('import-confirm');
    const committed = await snapshot();
    expect(committed.boards).toHaveLength(1);
    act(() => router.back()); await settle();
    expect(screen).toHavePathname('/settings');
    await press('settings-import');
    await settle();
    await act(async () => { release(); }); await settle();
    evidence('remount', { committed, afterRemount: await snapshot(), submitted: submit.mock.calls[0][1],
      previewReachable: screen.queryByTestId('import-preview') !== null,
      retryErrorReachable: screen.queryByTestId('import-error') !== null,
      chooserReachable: screen.queryByTestId('import-ripples') !== null });
    expect(await screen.findByTestId('import-error')).toHaveTextContent('interrupted', { exact: false });
    await press('import-confirm');
    expect(submit.mock.calls[1][1]).toEqual(submit.mock.calls[0][1]);
    expect(domainSnapshot(await snapshot())).toEqual(domainSnapshot(committed));
  });

  it('starts a distinct operation only after the explicit import-another-file action', async () => {
    const submit = jest.spyOn(commands, 'importSnapshot');
    await openImport(); await chooseCsv(); await press('import-confirm');
    const first = await snapshot();
    expect(await screen.findByTestId('import-summary')).toHaveTextContent('Added 1 board and 2 check-ins.');
    await press('import-again'); await chooseCsv(); await press('import-confirm');
    const second = await snapshot();
    evidence('intentional-new-import', { first, second, inputs: submit.mock.calls.map(call => call[1]) });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][1].commandId).not.toBe(submit.mock.calls[0][1].commandId);
    expect(second.boards).toHaveLength(2);
    expect(second.check_ins).toHaveLength(4);
    expect(second.habit_actions).toHaveLength(4);
    expect(second.coin_ledger).toEqual([]);
    for (const table of ['boards', 'check_ins', 'habit_actions', 'board_activity_periods', 'mutation_outbox']) {
      expect(second[table]).toEqual(expect.arrayContaining(first[table]));
    }
  });

  it('does not allocate an import attempt when the file picker is cancelled', async () => {
    const submit = jest.spyOn(commands, 'importSnapshot');
    await openImport();
    const before = await snapshot();
    dataTransferMock.nextPick = 'cancel';
    await press('import-ripples');
    expect(screen.getByTestId('import-ripples')).toBeOnTheScreen();
    expect(submit).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('offers same-receipt recovery when the committed import response throws', async () => {
    const actual = commands.importSnapshot;
    let original!: Awaited<ReturnType<typeof actual>>;
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      original = await actual(...args);
      expect(original.ok).toBe(true);
      throw new Error('The committed import response was interrupted.');
    });
    await openImport(); await chooseCsv();
    await press('import-confirm');
    const committed = await snapshot();
    const input = structuredClone(submit.mock.calls[0][1]);
    const receiptControl = await actual(await core(), input);
    evidence('thrown-response', { committed, input, original, receiptControl,
      errorReachable: screen.queryByTestId('import-error') !== null,
      confirmation: screen.getByTestId('import-confirm').props.accessibilityState });
    expect(committed.boards).toHaveLength(1);
    expect(committed.check_ins).toHaveLength(2);
    expect(receiptControl).toEqual(original);
    expect(await snapshot()).toEqual(committed);
    expect(await screen.findByTestId('import-error')).toBeOnTheScreen();
    await press('import-confirm');
    expect(submit.mock.calls[1][1]).toEqual(input);
    expect(domainSnapshot(await snapshot())).toEqual(domainSnapshot(committed));
  });

  it('ignores a queued confirmation from an import route that no longer owns the preview', async () => {
    const submit = jest.spyOn(commands, 'importSnapshot');
    await openImport(); await chooseCsv();
    const stale = screen.UNSAFE_getAllByType(ProductPressable)
      .find(button => button.props.testID === 'import-confirm')!.props.onPress;
    act(() => router.back()); await settle();
    await press('settings-import'); await chooseCsv();
    const before = await snapshot();
    act(() => stale()); await settle();
    evidence('stale-confirmation', { before, after: await snapshot(), calls: submit.mock.calls.length });
    expect(submit).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await press('import-confirm');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('ignores a queued old reset while a newer attempt is running or complete', async () => {
    const actual = commands.importSnapshot;
    await openImport(); await chooseCsv(); await press('import-confirm');
    const staleReset = screen.UNSAFE_getAllByType(ProductPressable)
      .find(button => button.props.testID === 'import-again')!.props.onPress;
    await press('import-again'); await chooseCsv();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const submit = jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      await gate;
      return actual(...args);
    });
    await press('import-confirm');
    act(() => staleReset()); await settle();
    const runningVisible = screen.queryByTestId('import-confirm')?.props.accessibilityState?.disabled === true;
    await act(async () => { release(); }); await settle();
    expect(await screen.findByTestId('import-done')).toBeOnTheScreen();
    const complete = await snapshot();
    act(() => staleReset()); await settle();
    evidence('stale-reset', { runningVisible, doneVisible: screen.queryByTestId('import-done') !== null,
      complete, after: await snapshot() });
    expect(runningVisible).toBe(true);
    expect(screen.getByTestId('import-done')).toBeOnTheScreen();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(complete);
  });

  it('ignores an old confirmation after import-another-file has selected a different preview', async () => {
    const submit = jest.spyOn(commands, 'importSnapshot');
    await openImport(); await chooseCsv();
    const stale = screen.UNSAFE_getAllByType(ProductPressable)
      .find(button => button.props.testID === 'import-confirm')!.props.onPress;
    await press('import-confirm'); await press('import-again');
    dataTransferMock.nextPick = { name: 'second.csv', contents: CSV.replace('imported habit', 'second habit') };
    await press('import-ripples');
    const before = await snapshot();
    act(() => stale()); await settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
    await press('import-confirm');
    expect((await snapshot()).boards.map(row => row.title).sort()).toEqual(['imported habit', 'second habit']);
  });

  it('owns the submitted draft before asynchronous command work or later preview mutation', async () => {
    const parse = jest.spyOn(parsers, 'parseRipplesCsv');
    const actual = commands.importSnapshot;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      await gate;
      return actual(...args);
    });
    await openImport(); await chooseCsv(); await press('import-confirm');
    const parsed = parse.mock.results[0].value;
    if (!parsed.ok) throw new Error('fixture did not parse');
    parsed.value.boards[0].title = 'mutated preview';
    parsed.value.checkIns[0].note = 'mutated note';
    parsed.value.boards.length = 0;
    await act(async () => { release(); }); await settle();
    expect(await screen.findByTestId('import-done')).toBeOnTheScreen();
    const rows = await snapshot();
    expect(rows.boards.map(row => row.title)).toEqual(['imported habit']);
    expect(rows.check_ins.map(row => row.note).sort()).toEqual(['first note', 'second note']);
  });

  it('blocks a duplicate picker and ignores its old result after a different route selects a file', async () => {
    let release!: (value: Awaited<ReturnType<typeof transfer.pickImportFile>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof transfer.pickImportFile>>>(resolve => { release = resolve; });
    const picker = jest.spyOn(transfer, 'pickImportFile').mockReturnValueOnce(pending);
    await openImport();
    const queued = screen.UNSAFE_getAllByType(ProductPressable)
      .find(button => button.props.testID === 'import-ripples')!.props.onPress;
    act(() => { queued(); queued(); }); await settle();
    const callsWhilePicking = picker.mock.calls.length;
    act(() => router.back()); await settle(); await press('settings-import');
    dataTransferMock.nextPick = { name: 'second.csv', contents: CSV.replace('imported habit', 'second habit') };
    await press('import-ripples');
    await act(async () => { release({ ok: true, value: { name: 'stale.csv', contents: CSV } }); }); await settle();
    expect(callsWhilePicking).toBe(1);
    expect(screen.getByTestId('import-preview')).toHaveTextContent('second.csv', { exact: false });
    await press('import-confirm');
    expect((await snapshot()).boards.map(row => row.title)).toEqual(['second habit']);
  });

  it('recovers a thrown picker without submitting or losing the chooser', async () => {
    jest.spyOn(transfer, 'pickImportFile').mockRejectedValueOnce(new Error('native picker failed'));
    const submit = jest.spyOn(commands, 'importSnapshot');
    await openImport(); await press('import-ripples');
    expect(await screen.findByTestId('import-error')).toHaveTextContent('The file could not be read.', { exact: false });
    expect(submit).not.toHaveBeenCalled();
    await chooseCsv(); await press('import-confirm');
    expect((await snapshot()).boards).toHaveLength(1);
  });

  it('isolates an uncertain attempt from a different provider core', async () => {
    const actual = commands.importSnapshot;
    jest.spyOn(commands, 'importSnapshot').mockImplementationOnce(async (...args) => {
      await actual(...args);
      return err('database', 'Response interrupted.', { retryable: true });
    });
    const firstCore = await core();
    const firstRoute = await openImport(); await chooseCsv(); await press('import-confirm');
    expect(await screen.findByTestId('import-error')).toBeOnTheScreen();
    const firstRows = await snapshot();
    firstRoute.unmount(); resetProductCoreForTests();
    await openImport();
    expect(screen.getByTestId('import-ripples')).toBeOnTheScreen();
    expect((await snapshot()).boards).toEqual([]);
    await chooseCsv(); await press('import-confirm');
    expect((await snapshot()).boards).toHaveLength(1);
    expect(await firstCore.db.getAllAsync('SELECT * FROM boards ORDER BY id')).toEqual(firstRows.boards);
  });

  it('recovers pre-dispatch id failure and presents a definitive refusal before a new file', async () => {
    const deps = await core();
    await openImport(); await chooseCsv();
    jest.spyOn(deps.ids, 'uuid').mockImplementationOnce(() => { throw new Error('id provider failed'); });
    await press('import-confirm');
    expect(await screen.findByTestId('import-error')).toHaveTextContent('could not be started', { exact: false });
    expect((await snapshot()).boards).toEqual([]);
    jest.spyOn(deps.ids, 'uuid').mockReturnValueOnce('not-a-command-id');
    await press('import-confirm');
    expect(await screen.findByTestId('import-error')).toHaveTextContent('Command ids must be uuids.');
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    expect((await snapshot()).boards).toEqual([]);
    await press('import-again'); await chooseCsv(); await press('import-confirm');
    expect((await snapshot()).boards).toHaveLength(1);
  });
});
