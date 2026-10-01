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

// a model spec is <provider>/<id>.
// - chatgpt: the ChatGPT subscription login. locally that is ~/.config/e2e/oauth.json
//   from `e2e login openai`; in ci the same json is supplied through
//   E2E_OAUTH_CREDENTIALS. `e2e models openai` lists the ids the login serves.
// - anthropic: an api key in E2E_ANTHROPIC_API_KEY. named this way on purpose so the
//   agent-fix workflow never sees an ANTHROPIC_API_KEY and keeps billing its subscription.
function modelFrom(spec: string) {
  const [provider, modelId] = spec.split('/');
  return provider === 'anthropic'
    ? createAnthropic({
        apiKey: process.env.E2E_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      })(modelId)
    : chatgpt(modelId);
}

// what the app calls things. read by every model call, the judges behind expect and
// agent.assert included, so it must be true for any tester of this app. how an agent
// should work goes in `system` below instead.
const context = [
  'Habit System is an iOS habit tracker built around boards.',
  'The home screen is the boards list. Its header has a Layout button (testID open-board-layout), a Settings gear (open-settings), and a Create board button (create-board).',
  'The Layout button opens a chooser with four options, each an accessibility-labelled pressable: "Full-width cards", "Two-column grid", "Compact rows", "14-day summary". Done (done-board-layout) closes it.',
  'Creating a board asks for a title (board-title-input) and saves with board-form-save. A board opens to its detail screen with check-ins, a heatmap, and an Add check-in button (add-check-in).',
  'Stacks group boards; Coins are earned by check-ins and spent on Rewards.',
  'Settings is a list: Notifications, Anchors, App icon, iCloud sync, Timeline, Export, Import, Archived boards, and a Version row (settings-version) at the very bottom.',
  'Text the app shows changes with the device date; do not treat a different date or count as a bug.',
].join(' ');

const system =
  'You are a careful QA agent testing a habit tracker for iOS. Do one goal at a time and verify every outcome on screen before finishing a step. Do not delete boards or check-ins you did not create.';

export default {
  targets: [{ name: 'ios', engine: iphone }],
  // on eas, one worker per leased phone. locally one simulator, one worker.
  workers: onEas ? Number(process.env.E2E_WORKERS ?? '1') : 1,
  // two agents, same instructions, different models. `default` is the strong model and
  // runs everything unless a test, a group, or `--agent fast` selects the other one.
  // `fast` is for cheap scripted steps; set E2E_FAST_MODEL to change its model.
  // agents do not inherit from each other, so both get the full context.
  agents: {
    default: createAgent({
      model: modelFrom(process.env.E2E_MODEL ?? 'chatgpt/gpt-6-luna'),
      tools: mobileTools(iphone),
      system,
      context,
    }),
    fast: createAgent({
      model: modelFrom(process.env.E2E_FAST_MODEL ?? 'chatgpt/gpt-5.6-luna'),
      tools: mobileTools(iphone),
      system,
      context,
    }),
  },
  // markdown writes .e2e/summary.md, which the pr workflow posts as the comment.
  reporters: ['list', 'markdown', 'junit'],
} satisfies E2EConfig;
