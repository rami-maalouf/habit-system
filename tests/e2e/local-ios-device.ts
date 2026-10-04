import type { DeviceProvider } from '@e2e-dev/mobile';
import { createAgentDeviceClient } from 'agent-device';

// select a local device explicitly so automatic discovery cannot cross device kinds.
export function localIosDevice(mode = 'simulator', device?: string): DeviceProvider {
  if (mode !== 'simulator' && mode !== 'device') {
    throw new Error('E2E_TARGET must be simulator or device.');
  }
  const selection = device?.trim() || (mode === 'simulator' ? 'Habit System QA' : undefined);

  return {
    name: `local-ios-${mode}`,
    async acquire(request) {
      request.signal.throwIfAborted();
      const client = createAgentDeviceClient({ cwd: request.projectRoot });
      const inventory = await client.devices.list({ platform: 'ios' });
      request.signal.throwIfAborted();
      const candidates = inventory.filter((entry) =>
        entry.platform === 'ios' && entry.target === 'mobile' && entry.kind === mode &&
        (mode === 'simulator' || entry.booted === true) &&
        (!selection || entry.id === selection || entry.name === selection),
      );
      if (candidates.length !== 1) {
        const problem = candidates.length === 0
          ? `No matching iOS ${mode}${selection ? ` (${selection})` : ''}.`
          : `Multiple iOS ${mode}s: ${candidates.map((entry) => `${entry.name} (${entry.id})`).join(', ')}.`;
        throw new Error(`${problem} Set E2E_DEVICE to the name or UDID of an available ${mode}.`);
      }
      const selected = candidates[0];
      request.log(`using iOS ${mode}: ${selected.name} (${selected.id})`);
      return { id: selected.id, deviceId: selected.id, client: { cwd: request.projectRoot } };
    },
    async release() {
      // the mobile engine closes its session; keep the user's device and app data.
    },
  };
}
