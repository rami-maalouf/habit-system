import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useBoardLayout } from '@/features/boards/use-board-layout';
import { readBoardLayout, writeBoardLayout } from '@/platform/board-layout';

const mockCore = {};
let mockKind: 'real' | 'sample' = 'real';
let mockActive = true;
jest.mock('@/features/product-store', () => ({ useProduct: () => ({
  core: mockCore, scope: { kind: mockKind, isCurrent: () => mockActive },
}) }));
jest.mock('@/platform/board-layout', () => ({ readBoardLayout: jest.fn(), writeBoardLayout: jest.fn() }));
const read = jest.mocked(readBoardLayout);
const write = jest.mocked(writeBoardLayout);

beforeEach(() => {
  mockKind = 'real'; mockActive = true;
  read.mockReset().mockResolvedValue('compact');
  write.mockReset().mockResolvedValue(undefined);
});

it('keeps sample changes in memory without reading or writing the real preference', async () => {
  mockKind = 'sample';
  const first = renderHook(useBoardLayout);
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  await act(() => first.result.current.select('grid'));
  first.unmount();
  const second = renderHook(useBoardLayout);
  await waitFor(() => expect(second.result.current.layout).toBe('grid'));
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('defaults unknown stored values to compact and avoids writing an unchanged choice', async () => {
  read.mockResolvedValue('unknown');
  const { result } = renderHook(useBoardLayout);
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.layout).toBe('compact');
  await act(() => result.current.select('compact'));
  expect(write).not.toHaveBeenCalled();
});

it('recovers a failed read by explicitly saving the chosen layout', async () => {
  read.mockRejectedValue(new Error('unavailable'));
  const { result } = renderHook(useBoardLayout);
  await waitFor(() => expect(result.current.error).toContain('Could not load'));
  await act(() => result.current.select('compact'));
  expect(write).toHaveBeenCalledWith('compact');
  expect(result.current.error).toBeNull();
});

it('guards queued selections while saving and rejects suspended scope actions', async () => {
  let finish!: () => void;
  write.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useBoardLayout);
  await waitFor(() => expect(result.current.ready).toBe(true));
  let pending!: Promise<void>;
  act(() => { pending = result.current.select('grid'); void result.current.select('cards'); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(true);
  await act(async () => { finish(); await pending; });
  expect(result.current.layout).toBe('grid');
  mockActive = false;
  await act(() => result.current.select('cards'));
  expect(write).toHaveBeenCalledTimes(1);
});
