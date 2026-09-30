import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { mobile } from '@e2e-dev/mobile';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { createAnthropic } from '@ai-sdk/anthropic';
import { easSimulator } from './tests/e2e/eas-simulator-provider';

// where the tests run.
// - default: a local booted simulator that already has the app. E2E_DEVICE picks one by
//   name or udid; without it, any booted ios simulator.
// - E2E_EAS_SIMULATOR=1: lease EAS Simulator sessions instead, one per worker, each with
//   the build E2E_BUILD_ID installed. E2E_WORKERS sets how many cloud iphones run at
//   once; test files spread across them.
const onEas = process.env.E2E_EAS_SIMULATOR === '1';

const iphone = mobile({
  platform: 'ios',
  app: 'studio.orbitlabs.habitsystem',
  device: onEas
    ? easSimulator({
        buildId: process.env.E2E_BUILD_ID,
        deviceName: process.env.E2E_EAS_DEVICE,
        command: process.env.E2E_EAS_COMMAND?.split(' '),
      })
    : process.env.E2E_DEVICE,
});

// E2E_MODEL picks the model as <provider>/<id>.
// - chatgpt (default): the ChatGPT subscription login. locally that is
//   ~/.config/e2e/oauth.json from `e2e login openai`; in ci the same json is
//   supplied through E2E_OAUTH_CREDENTIALS.
// - anthropic: an api key in E2E_ANTHROPIC_API_KEY. named this way on purpose so the
//   agent-fix workflow never sees an ANTHROPIC_API_KEY and keeps billing its subscription.
const [provider, modelId] = (process.env.E2E_MODEL ?? 'chatgpt/gpt-6-luna').split('/');
const model =
  provider === 'anthropic'
    ? createAnthropic({
        apiKey: process.env.E2E_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      })(modelId)
    : chatgpt(modelId);

export default {
  targets: [{ name: 'ios', engine: iphone }],
  // on eas, one worker per leased phone. locally one simulator, one worker.
  workers: onEas ? Number(process.env.E2E_WORKERS ?? '1') : 1,
  agents: {
    default: createAgent({
      model,
      tools: mobileTools(iphone),
      system:
        'You are a careful QA agent testing a habit tracker for iOS. Do one goal at a time and verify every outcome on screen.',
    }),
  },
  // markdown writes .e2e/summary.md, which the pr workflow posts as the comment.
  reporters: ['list', 'markdown', 'junit'],
} satisfies E2EConfig;
