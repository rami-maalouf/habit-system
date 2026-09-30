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
  await agent.act('scroll to the bottom of the settings screen');
  await expect(screen.getByTestId('settings-version')).toBeVisible();
});
