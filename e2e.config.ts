import type { E2EConfig } from 'e2e';
import { createAgent } from 'e2e/agent';
import { mobile } from '@e2e-dev/mobile';
import { mobileTools } from '@e2e-dev/mobile/tools';
import { createAnthropic } from '@ai-sdk/anthropic';

// the app under test, driven through agent-device.
//
// on an EAS Simulator session the app is installed by `eas simulator:start --build-id`
// and `eas simulator:exec` points agent-device at the remote daemon, so no appPath is
// needed. locally, set E2E_DEVICE to a booted simulator that already has the app.
const iphone = mobile({
  platform: 'ios',
  app: 'studio.orbitlabs.habitsystem',
  device: process.env.E2E_DEVICE,
});

// E2E_ANTHROPIC_API_KEY keeps the e2e key separate from ANTHROPIC_API_KEY, which the
// agent-fix workflow must not see (it would bill the api instead of the subscription).
const anthropic = createAnthropic({
  apiKey: process.env.E2E_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
});

export default {
  targets: [{ name: 'ios', engine: iphone }],
  // one simulator, one worker. deterministic tests need no model; agent steps do.
  workers: 1,
  agents: {
    default: createAgent({
      model: anthropic(process.env.E2E_MODEL ?? 'claude-haiku-4-5'),
      tools: mobileTools(iphone),
      system:
        'You are a careful QA agent testing a habit tracker for iOS. Do one goal at a time and verify every outcome on screen.',
    }),
  },
  // markdown writes .e2e/summary.md, which the pr workflow posts as the comment.
  reporters: ['list', 'markdown', 'junit'],
} satisfies E2EConfig;
