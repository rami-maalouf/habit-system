import { useSyncExternalStore } from 'react';

import type { BoardAnchorInput } from '@/core/domain/board-anchor';

import type { Board, BoardKind } from '@/core/domain/entities';
import { boardPalette, boardSymbolAllowlist } from '@/core/domain/entities';
import type { BoardId } from '@/core/domain/ids';
import type { ProductCore } from '@/platform/database/product-core';

// reminders drafted on an unsaved board commit together with the board;
// existing boards edit their reminders directly through commands
export type DraftReminder = {
  weekdaysMask: number;
  minuteOfDay: number;
  message: string;
  enabled: boolean;
};

// one in-flight board draft shared across the create/edit sheet and its
// options screen; sheets read and write the draft, saving commits it
export type BoardDraft = {
  boardId: BoardId | null;
  expectedMutationStamp: string | null;
  kind: BoardKind;
  title: string;
  symbol: string;
  accentHex: string;
  usesTintedBackground: boolean;
  tracksAmount: boolean;
  amountUnit: string;
  quickAmountText: string;
  tracksTime: boolean;
  startOfDayMinute: number;
  metricsEnabled: boolean;
  anchor: BoardAnchorInput | null;
  usualTimeMinute: number | null;
  requiredInStack: boolean;
  earnsCoins: boolean;
  coinCapPerDay: number;
  // populated only while boardId is null (a new, unsaved board)
  reminders: DraftReminder[];
  dirty: boolean;
};

// a draft session exists only while a form sheet owns it; screens that read
// the draft outside a session (direct navigation to options) must bail out
type DraftState = {
  draft: BoardDraft;
  active: boolean;
  // the unique sheet owner reserves the session before its board read finishes
  owner: string | null;
};

export function newBoardDraft(): BoardDraft {
  return {
    boardId: null,
    expectedMutationStamp: null,
    kind: 'daily',
    title: '',
    symbol: boardSymbolAllowlist[1],
    accentHex: boardPalette[2].hex,
    usesTintedBackground: true,
    tracksAmount: false,
    amountUnit: '',
    quickAmountText: '1',
    tracksTime: false,
    startOfDayMinute: 0,
    metricsEnabled: true,
    anchor: null,
    usualTimeMinute: null,
    requiredInStack: true,
    earnsCoins: false,
    coinCapPerDay: 1,
    reminders: [],
    dirty: false,
  };
}

export function draftFromBoard(board: Board): BoardDraft {
  return {
    boardId: board.id,
    expectedMutationStamp: board.mutationStamp,
    kind: board.kind,
    title: board.title,
    symbol: board.symbol,
    accentHex: board.accentHex,
    usesTintedBackground: board.usesTintedBackground,
    tracksAmount: board.tracksAmount,
    amountUnit: board.amountUnit ?? '',
    quickAmountText: String(board.quickAmount),
    tracksTime: board.tracksTime,
    startOfDayMinute: board.startOfDayMinute,
    metricsEnabled: board.metricsEnabled,
    anchor: board.anchorKind === 'board' && board.anchorBoardId && board.anchorRelation
      ? { kind: 'board', relation: board.anchorRelation, boardId: board.anchorBoardId }
      : board.anchorKind === 'preset' && board.anchorPreset && board.anchorRelation
        ? { kind: 'preset', relation: board.anchorRelation, preset: board.anchorPreset }
        : board.anchorKind === 'text' && board.anchorText && board.anchorRelation
          ? { kind: 'text', relation: board.anchorRelation, text: board.anchorText }
          : null,
    usualTimeMinute: board.usualTimeMinute,
    requiredInStack: board.requiredInStack,
    earnsCoins: board.earnsCoins,
    coinCapPerDay: board.coinCapPerDay,
    reminders: [],
    dirty: false,
  };
}

export type DraftStore = {
  getSnapshot(): DraftState;
  subscribe(listener: () => void): () => void;
  begin(owner: string): void;
  start(draft: BoardDraft, owner: string): void;
  end(owner: string): void;
  owns(owner: string | null, boardId: BoardId | null): boolean;
  update(owner: string | null, patch: Partial<BoardDraft>): boolean;
};

const stores = new WeakMap<ProductCore, DraftStore>();

export function draftStoreFor(core: ProductCore): DraftStore {
  const existing = stores.get(core);
  if (existing) return existing;
  let current: DraftState = { draft: newBoardDraft(), active: false, owner: null };
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const store: DraftStore = {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin: owner => { current = { draft: current.draft, active: false, owner }; emit(); },
    start: (draft, owner) => { current = { draft, active: true, owner }; emit(); },
    end: owner => {
      if (current.owner !== owner) return;
      current = { draft: current.draft, active: false, owner: null };
      emit();
    },
    owns: (owner, boardId) => owner !== null && current.active && current.owner === owner && current.draft.boardId === boardId,
    update: (owner, patch) => {
      if (owner === null || !current.active || current.owner !== owner) return false;
      current = { ...current, draft: { ...current.draft, ...patch, dirty: true } };
      emit();
      return true;
    },
  };
  stores.set(core, store);
  return store;
}

let ownerSequence = 0;

// owner tokens must be unique per mount: react's useId repeats across
// remounts in the same tree position, so a dismissed sheet's delayed
// cleanup could kill its successor's session
export function newDraftOwner(): string {
  ownerSequence += 1;
  return `draft-owner-${ownerSequence}`;
}

export function getDraftState(core: ProductCore): DraftState {
  return draftStoreFor(core).getSnapshot();
}

export function useDraftState(core: ProductCore): DraftState {
  const store = draftStoreFor(core);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useBoardDraft(core: ProductCore): BoardDraft {
  return useDraftState(core).draft;
}
