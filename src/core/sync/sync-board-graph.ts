import type { SqlExecutor } from '../persistence/database';
import type { Schema2MutableRecord } from './inbound-validation';

// one transaction owns this snapshot; only already validated, would-win board rows enter it.
export async function readSyncBoardGraph(tx: SqlExecutor) {
  const rows = await tx.getAllAsync<{ id: string; anchor_kind: string | null; anchor_board_id: string | null }>(
    'SELECT id, anchor_kind, anchor_board_id FROM boards WHERE deleted_at IS NULL',
  );
  const parents = new Map<string, string | null>();
  const children = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.anchor_kind === 'board' && row.anchor_board_id === null) throw new Error('Stored anchor graph is invalid.');
    const target = row.anchor_kind === 'board' ? row.anchor_board_id : null;
    parents.set(row.id, target);
    if (target !== null) {
      const members = children.get(target) ?? new Set<string>();
      members.add(row.id); children.set(target, members);
    }
  }
  const complete = new Set<string>();
  for (const id of parents.keys()) {
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current) || !parents.has(current)) throw new Error('Stored anchor graph is invalid.');
      path.add(current); current = parents.get(current)!;
    }
    for (const member of path) complete.add(member);
  }
  return {
    allows(record: Schema2MutableRecord): boolean {
      if (record.deleted) return (children.get(record.entityId)?.size ?? 0) === 0;
      let current = record.fields.anchor_kind === 'board' ? record.fields.anchor_board_id as string : null;
      while (current !== null) {
        if (current === record.entityId || !parents.has(current)) return false;
        current = parents.get(current)!;
      }
      return true;
    },
    commit(record: Schema2MutableRecord): boolean {
      const id = record.entityId;
      const previous = parents.get(id);
      const target = record.deleted ? undefined : record.fields.anchor_kind === 'board' ? record.fields.anchor_board_id as string : null;
      if (previous === target) return false;
      if (previous !== undefined && previous !== null) children.get(previous)!.delete(id);
      if (target === undefined) parents.delete(id);
      else {
        parents.set(id, target);
        if (target !== null) {
          const members = children.get(target) ?? new Set<string>();
          members.add(id); children.set(target, members);
        }
      }
      return true;
    },
  };
}

export type SyncBoardGraph = Awaited<ReturnType<typeof readSyncBoardGraph>>;
