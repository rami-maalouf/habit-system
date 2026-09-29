import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

// the first two tests are deterministic and run without a model.
// the last two drive one goal each through the agent and pin the outcome with expect.
// none of them clear app state, so they are safe on a simulator that holds sample data.

test('the app opens on the boards home', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  await expect(screen.getByTestId('open-settings')).toBeVisible();
});

test('settings opens from the boards home', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  await expect(screen.getByTestId('settings-notifications')).toBeVisible();
});

test('a board created in plain english shows up on the home screen', async ({ app, agent, screen }) => {
  await app.open();
  // a unique name so reruns on the same device do not collide.
  const name = `Morning walk ${Date.now().toString().slice(-5)}`;
  await agent.act('create a new board named {name} and save it', { params: { name } });
  await expect(screen.getByText(name).first()).toBeVisible();
});

test('the version row is reachable at the bottom of settings', async ({ app, agent, screen }) => {
  await app.open();
  await screen.getByTestId('open-settings').tap();
  await agent.act('scroll to the bottom of the settings screen');
  await expect(screen.getByTestId('settings-version')).toBeVisible();
});
