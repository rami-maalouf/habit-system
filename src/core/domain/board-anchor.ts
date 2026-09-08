import type { AnchorPreset, AnchorRelation, Board } from './entities';
import type { BoardId } from './ids';
import { isUuidV4 } from './ids';
import type { DomainResult } from './result';
import { err, ok } from './result';

export type BoardAnchorInput =
  | { kind: 'board'; relation: AnchorRelation; boardId: BoardId }
  | { kind: 'preset'; relation: AnchorRelation; preset: AnchorPreset }
  | { kind: 'text'; relation: AnchorRelation; text: string };

export type BoardAnchorOptions = {
  anchor?: BoardAnchorInput | null;
  usualTimeMinute?: number | null;
  requiredInStack?: boolean;
};

export type BoardAnchorFields = Pick<Board,
  'anchorRelation' | 'anchorKind' | 'anchorBoardId' | 'anchorPreset' | 'anchorText' |
  'usualTimeMinute' | 'requiredInStack'>;

export const EMPTY_BOARD_ANCHOR = {
  anchorRelation: null, anchorKind: null, anchorBoardId: null, anchorPreset: null, anchorText: null,
} as const;

export function normalizeBoardAnchorFields(input: BoardAnchorOptions): DomainResult<Partial<BoardAnchorFields>> {
  const fields: Partial<BoardAnchorFields> = {};
  if (input.anchor !== undefined) {
    Object.assign(fields, EMPTY_BOARD_ANCHOR);
    const anchor = input.anchor;
    if (anchor !== null) {
      if (typeof anchor !== 'object' || Array.isArray(anchor) ||
          (anchor.relation !== 'before' && anchor.relation !== 'after') ||
          !['board', 'preset', 'text'].includes(anchor.kind)) {
        return err('validation', 'Choose a valid anchor and Before or After.', { field: 'anchor' });
      }
      const targetKey = anchor.kind === 'board' ? 'boardId' : anchor.kind === 'preset' ? 'preset' : 'text';
      if (Object.keys(anchor).some((key) => !['kind', 'relation', targetKey].includes(key))) {
        return err('validation', 'Choose exactly one anchor target.', { field: 'anchor' });
      }
      fields.anchorKind = anchor.kind;
      fields.anchorRelation = anchor.relation;
      if (anchor.kind === 'board') {
        if (typeof anchor.boardId !== 'string' || !isUuidV4(anchor.boardId)) {
          return err('validation', 'Choose an existing habit as the anchor.', { field: 'anchor' });
        }
        fields.anchorBoardId = anchor.boardId;
      } else if (anchor.kind === 'preset') {
        if (!['wake', 'lunch', 'dinner', 'sleep'].includes(anchor.preset)) {
          return err('validation', 'Choose one of the four built-in anchors.', { field: 'anchor' });
        }
        fields.anchorPreset = anchor.preset;
      } else {
        if (typeof anchor.text !== 'string' || [...anchor.text.trim()].length === 0 || [...anchor.text.trim()].length > 80) {
          return err('validation', 'Describe the anchor in 1 to 80 characters.', { field: 'anchor' });
        }
        fields.anchorText = anchor.text.trim();
      }
    }
  }
  if (input.usualTimeMinute !== undefined) {
    const minute = input.usualTimeMinute;
    if (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute > 1425 || minute % 15 !== 0)) {
      return err('validation', 'Choose a usual time in 15-minute steps from 00:00 to 23:45.', { field: 'usualTimeMinute' });
    }
    fields.usualTimeMinute = minute;
  }
  if (input.requiredInStack !== undefined) {
    if (typeof input.requiredInStack !== 'boolean') {
      return err('validation', 'Choose whether this habit is required in its stack.', { field: 'requiredInStack' });
    }
    fields.requiredInStack = input.requiredInStack;
  }
  return ok(fields);
}

export function validateBoardAnchorGraph(
  sourceId: BoardId | null,
  targetId: BoardId | null,
  boards: readonly Board[],
): DomainResult<void> {
  const byId = new Map(boards.map((board) => [board.id, board]));
  const visited = new Set<BoardId>();
  let next = targetId;
  while (next !== null) {
    if (next === sourceId || visited.has(next)) {
      return err('validation', 'An anchor cannot link a habit back to itself.', { field: 'anchor' });
    }
    visited.add(next);
    const board = byId.get(next);
    if (!board || board.deletedAt !== null) {
      return err('validation', 'This anchor habit no longer exists. Choose another anchor.', { field: 'anchor' });
    }
    if (board.anchorKind !== 'board') return ok(undefined);
    next = board.anchorBoardId;
  }
  return err('validation', 'This anchor chain has a missing habit. Choose another anchor.', { field: 'anchor' });
}
