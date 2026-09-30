import Storage from 'expo-sqlite/kv-store';

export type BoardLayout = 'cards' | 'grid' | 'compact' | 'summary';

const KEY = 'boards.layout';

export function readBoardLayout(): Promise<string | null> { return Storage.getItem(KEY); }
export function writeBoardLayout(value: BoardLayout): Promise<void> { return Storage.setItem(KEY, value); }
