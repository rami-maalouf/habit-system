import { act } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { archiveBoard, createBoard, createCheckIn, deleteBoard } from '@/core/domain/commands';
import type { BoardId } from '@/core/domain/ids';
import * as queries from '@/core/domain/queries';
import { err } from '@/core/domain/result';
import { getBoardById } from '@/core/persistence/repositories/boards';

import { getProductCore, newCommandId, resetProductCoreForTests } from '../../../src/testing/product-core.mock';
import { fireEvent, renderRouter, screen, settle } from '../../../src/testing/render';

async function core() {
  const result = await getProductCore();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function seedBoard(title: string, anchorBoardId?: BoardId) {
  const result = await createBoard(await core(), {
    commandId: newCommandId(), title, kind: 'count', symbol: 'star.fill', accentHex: '#70A7FF',
    usesTintedBackground: false, tracksAmount: false, tracksTime: false,
    startOfDayMinute: 0, metricsEnabled: true,
    ...(anchorBoardId ? { anchor: { kind: 'board' as const, relation: 'after' as const, boardId: anchorBoardId } } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.boardId;
}

async function openDelete(boardId: BoardId, archived: boolean) {
  if (archived) expect((await archiveBoard(await core(), { commandId: newCommandId(), boardId })).ok).toBe(true);
  renderRouter('src/app', { initialUrl: `/boards/${boardId}${archived ? '' : '/edit'}` });
  const button = await screen.findByTestId(archived ? 'delete-board' : 'form-delete-board');
  fireEvent.press(button);
  await settle();
}

describe('anchor cleanup in board deletion confirmation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetProductCoreForTests();
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  it.each([false, true])('describes direct active and archived links, and retains their habits and history after confirmation (archived target: %s)', async (archived) => {
    const deps = await core();
    const root = await seedBoard('anchor root');
    const active = await seedBoard('active dependent', root);
    const archivedDependent = await seedBoard('archived dependent', root);
    const grandchild = await seedBoard('indirect dependent', active);
    const removed = await seedBoard('already deleted dependent', root);
    for (const boardId of [active, archivedDependent, grandchild]) {
      expect((await createCheckIn(deps, { commandId: newCommandId(), boardId, source: 'app', note: `history ${boardId}` })).ok).toBe(true);
    }
    expect((await archiveBoard(deps, { commandId: newCommandId(), boardId: archivedDependent })).ok).toBe(true);
    expect((await deleteBoard(deps, { commandId: newCommandId(), boardId: removed })).ok).toBe(true);
    const history = await deps.db.getAllAsync('SELECT * FROM check_ins ORDER BY id');
    await openDelete(root, archived);
    const before = await deps.db.getAllAsync('SELECT * FROM boards ORDER BY id');
    const first = jest.mocked(Alert.alert).mock.calls.at(-1);
    expect(first?.[1]).toContain('removes the anchor from 2 habits');
    expect(first?.[1]).toContain('Those habits and their history remain.');
    expect(first?.[1]).not.toMatch(/3 habits|deletes 2 habits/);
    act(() => { first?.[2]?.find((button) => button.style === 'cancel')?.onPress?.(); });
    await settle();
    expect(await deps.db.getAllAsync('SELECT * FROM boards ORDER BY id')).toEqual(before);
    fireEvent.press(screen.getByTestId(archived ? 'delete-board' : 'form-delete-board'));
    await settle();
    const confirmed = jest.mocked(Alert.alert).mock.calls.at(-1);
    act(() => { confirmed?.[2]?.find((button) => button.style === 'destructive')?.onPress?.(); });
    await settle();
    expect(await getBoardById(deps.db, root)).toBeNull();
    for (const boardId of [active, archivedDependent]) {
      expect(await getBoardById(deps.db, boardId)).toMatchObject({ anchorKind: null, anchorBoardId: null, deletedAt: null });
    }
    expect(await getBoardById(deps.db, archivedDependent)).toMatchObject({ archivedAt: expect.any(Number) });
    expect(await getBoardById(deps.db, grandchild)).toMatchObject({ anchorKind: 'board', anchorBoardId: active });
    expect(await deps.db.getAllAsync('SELECT * FROM check_ins ORDER BY id')).toEqual(history);
  });

  it('uses singular preservation wording for one anchored habit', async () => {
    const root = await seedBoard('one anchor');
    await seedBoard('only dependent', root);
    await openDelete(root, false);
    const message = jest.mocked(Alert.alert).mock.calls.at(-1)?.[1];
    expect(message).toContain('removes the anchor from 1 habit.');
    expect(message).toContain('That habit and its history remain.');
  });

  it.each([false, true])('omits anchor impact when no habits depend on the board (archived target: %s)', async (archived) => {
    const root = await seedBoard('no dependents');
    await openDelete(root, archived);
    const message = jest.mocked(Alert.alert).mock.calls.at(-1)?.[1];
    expect(message).toBe('This permanently deletes 0 check-ins, 0 notes, and 0 reminders.');
    expect(message).not.toMatch(/anchor|undefined|NaN/);
  });

  it.each([false, true])('acknowledges anchor removal without an invented count when the query fails (archived target: %s)', async (archived) => {
    const root = await seedBoard('unknown impact');
    jest.spyOn(queries, 'getBoardDependentCounts').mockResolvedValueOnce(err('database', 'temporary read failure'));
    await openDelete(root, archived);
    const message = jest.mocked(Alert.alert).mock.calls.at(-1)?.[1];
    expect(message).toContain('permanently deletes the board and everything it contains');
    expect(message).toContain('Habits anchored to this board will lose that anchor.');
    expect(message).toContain('Those habits and their history remain.');
    expect(message).not.toMatch(/\d+ habits|undefined|NaN/);
    expect(await getBoardById((await core()).db, root)).not.toBeNull();
  });
});
