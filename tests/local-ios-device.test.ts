import type { DeviceRequest } from '@e2e-dev/mobile';
import { localIosDevice } from './e2e/local-ios-device';

const mockList = jest.fn();
jest.mock('agent-device', () => ({
  createAgentDeviceClient: () => ({ devices: { list: mockList } }),
}), { virtual: true });

const simulator = { id: 'sim-id', name: 'Habit System QA', kind: 'simulator', platform: 'ios', target: 'mobile', booted: false };
const phone = { id: 'phone-id', name: 'My iPhone', kind: 'device', platform: 'ios', target: 'mobile', booted: true };
const request = {
  platform: 'ios', runId: 'run', targetName: 'ios', slot: 0, slots: 1,
  agentDeviceVersion: 'test', projectRoot: process.cwd(), env: {},
  signal: new AbortController().signal, log: jest.fn(),
} satisfies DeviceRequest;

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([phone, simulator]);
});

it('defaults to the dedicated simulator even with a connected phone', async () => {
  expect(await localIosDevice().acquire(request)).toMatchObject({ deviceId: 'sim-id' });
});

it('selects the connected physical phone when requested', async () => {
  expect(await localIosDevice('device').acquire(request)).toMatchObject({ deviceId: 'phone-id' });
});

it.each(['sim-id', 'Habit System QA'])('selects a simulator explicitly by %s', async (name) => {
  expect(await localIosDevice('simulator', name).acquire(request)).toMatchObject({ deviceId: 'sim-id' });
});

it('never falls back to a phone when the simulator is missing', async () => {
  mockList.mockResolvedValue([phone]);
  await expect(localIosDevice().acquire(request)).rejects.toThrow('No matching iOS simulator');
});

it('never accepts a phone override in simulator mode', async () => {
  await expect(localIosDevice('simulator', phone.id).acquire(request)).rejects.toThrow('No matching iOS simulator');
});

it('never falls back to a simulator when no phone is connected', async () => {
  mockList.mockResolvedValue([simulator, { ...phone, booted: false }]);
  await expect(localIosDevice('device').acquire(request)).rejects.toThrow('No matching iOS device');
});

it('requires an explicit choice when multiple phones are connected', async () => {
  mockList.mockResolvedValue([phone, { ...phone, id: 'second-phone', name: 'Second iPhone' }]);
  await expect(localIosDevice('device').acquire(request)).rejects.toThrow('E2E_DEVICE');
  expect(await localIosDevice('device', 'second-phone').acquire(request)).toMatchObject({ deviceId: 'second-phone' });
});

it('rejects misspelled modes before contacting a device', () => {
  expect(() => localIosDevice('simluator')).toThrow('E2E_TARGET');
  expect(mockList).not.toHaveBeenCalled();
});

it('does not select a tv or android device', async () => {
  mockList.mockResolvedValue([
    { ...phone, platform: 'android' },
    { ...phone, target: 'tv' },
  ]);
  await expect(localIosDevice('device').acquire(request)).rejects.toThrow('No matching iOS device');
});

it('leaves device ownership and cleanup to the mobile engine', async () => {
  const provider = localIosDevice();
  const lease = await provider.acquire(request);
  await expect(provider.release(lease, request)).resolves.toBeUndefined();
  expect(mockList).toHaveBeenCalledTimes(1);
});
