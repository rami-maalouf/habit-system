import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';

// a device provider that leases one EAS Simulator session per worker slot.
//
// e2e calls acquire() once per slot when the run starts and release() for every lease
// when it ends, on every exit path. each lease points the worker's agent-device client
// at the session's remote daemon, so `workers: 3` drives three cloud iphones at once.
//
// the session json from `eas simulator:start --json` carries the daemon address in
// remoteConfig.agentDeviceRemoteSessionUrl and the token in
// remoteConfig.agentDeviceRemoteSessionToken; the cli maps those to
// AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN in .env.eas-simulator
// (eas-cli build/simulator/utils.js, getControllerEnvironmentVariables). we read the
// json directly and pass `--out-config-type env` so parallel sessions never fight over
// that dotenv file.
//
// this file sits under tests/e2e/ on purpose: the repo's .easignore drops /e2e/ from
// project uploads, and the runner only collects *.e2e.ts, so it is uploaded but not run.

export interface EasSimulatorOptions {
  /** eas build id to install and launch before the session is ready. */
  readonly buildId?: string | undefined;
  /** simulator device name, for example "iPhone 17 Pro". defaults to the runner's pick. */
  readonly deviceName?: string | undefined;
  /** hard cap on the session; the run's cleanup stops it earlier. default 30. */
  readonly maxDurationMinutes?: number | undefined;
  /** idle cap, in case release never runs. default 10. */
  readonly maxIdleMinutes?: number | undefined;
  /** file that collects one session page url per line, for the pr comment. */
  readonly sessionUrlsFile?: string | undefined;
  /** file that collects one session id per line, for a last-resort stop step. */
  readonly sessionIdsFile?: string | undefined;
  /** the eas cli command. default ["eas"]. */
  readonly command?: readonly string[] | undefined;
}

interface SessionJson {
  id?: string;
  deviceRunSessionUrl?: string;
  remoteConfig?: {
    agentDeviceRemoteSessionUrl?: string;
    agentDeviceRemoteSessionToken?: string;
  };
}

interface EasResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runEas(
  command: readonly string[],
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<EasResult> {
  return new Promise((resolve, reject) => {
    const [bin, ...prefix] = command;
    const child: ChildProcess = spawn(bin, [...prefix, ...args], {
      // the run's env is a plain record; node's typing wants ProcessEnv.
      env: { ...env, CI: env.CI ?? '1' } as unknown as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: Error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

// the cli prints the json object among other lines (shell exports, npm notices).
// take the first "{" whose slice up to the last "}" parses.
function parseSessionJson(stdout: string): SessionJson | undefined {
  const end = stdout.lastIndexOf('}');
  if (end < 0) return undefined;
  let start = stdout.indexOf('{');
  while (start >= 0 && start < end) {
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as SessionJson;
    } catch {
      start = stdout.indexOf('{', start + 1);
    }
  }
  return undefined;
}

async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${line}\n`);
}

export function easSimulator(options: EasSimulatorOptions = {}): DeviceProvider {
  const command = options.command ?? ['eas'];
  const urlsFile = options.sessionUrlsFile ?? '.e2e/session-urls.txt';
  const idsFile = options.sessionIdsFile ?? '.e2e/session-ids.txt';

  return {
    name: 'eas-simulator',

    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      const name = `e2e ${request.runId.slice(0, 8)} ${request.targetName} ${request.slot + 1}/${request.slots}`;
      const args = [
        'simulator:start',
        '--platform',
        request.platform,
        '--type',
        'agent-device',
        '--name',
        name,
        '--max-duration-minutes',
        String(options.maxDurationMinutes ?? 30),
        '--max-idle-time-minutes',
        String(options.maxIdleMinutes ?? 10),
        '--out-config-type',
        'env',
        '--json',
        '--non-interactive',
      ];
      if (options.buildId) args.push('--build-id', options.buildId);
      if (options.deviceName) args.push('--device', options.deviceName);

      request.log(`leasing an eas simulator (${name})`);
      const result = await runEas(command, args, request.env, request.signal);
      const session = parseSessionJson(result.stdout);
      const baseUrl = session?.remoteConfig?.agentDeviceRemoteSessionUrl;
      const authToken = session?.remoteConfig?.agentDeviceRemoteSessionToken;
      if (result.code !== 0 || !session?.id || !baseUrl) {
        const tail = `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-12).join('\n');
        throw new Error(`eas simulator:start failed (exit ${result.code}) for ${name}:\n${tail}`);
      }

      await appendLine(idsFile, session.id);
      if (session.deviceRunSessionUrl) {
        await appendLine(urlsFile, session.deviceRunSessionUrl);
        request.log(`eas simulator ${session.id} ready, watch at ${session.deviceRunSessionUrl}`);
      } else {
        request.log(`eas simulator ${session.id} ready`);
      }

      return { id: session.id, daemon: { baseUrl, authToken } };
    },

    async release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void> {
      const result = await runEas(
        command,
        ['simulator:stop', '--id', lease.id, '--json', '--non-interactive'],
        context.env,
        context.signal,
      );
      if (result.code === 0) {
        context.log(`eas simulator ${lease.id} stopped`);
      } else {
        // never fail the run's cleanup; the workflow has a last-resort stop step.
        context.log(`eas simulator:stop ${lease.id} exited ${result.code}; stop it from the sessions page`);
      }
    },
  };
}
