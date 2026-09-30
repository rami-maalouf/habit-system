import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

// the settings screen. one deterministic test and one agent test.

test('settings opens from the boards home', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  await expect(screen.getByTestId('settings-notifications')).toBeVisible();
});

test('the version row is reachable at the bottom of settings', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  // name the target: a bare "scroll to the bottom" once failed because one swipe reported
  // no scroll change and the agent gave up before the list had moved.
  await agent.act('scroll down the settings list until the Version row at the very bottom is visible');
  await expect(screen.getByTestId('settings-version')).toBeVisible();
});
