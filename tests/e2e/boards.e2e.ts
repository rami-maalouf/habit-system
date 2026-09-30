import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

// the boards home. one deterministic test and one agent test.
// test files spread across workers, so each file is one phone's worth of work.
// nothing here clears app state, so it is safe on a simulator that holds sample data.

test('the app opens on the boards home', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByTestId('create-board')).toBeVisible();
  await expect(screen.getByTestId('open-settings')).toBeVisible();
});

test('a board created in plain english shows up on the home screen', async ({ app, agent, screen }) => {
  await app.open();
  // a unique name so reruns on the same device do not collide.
  const name = `Morning walk ${Date.now().toString().slice(-5)}`;
  await agent.act('create a new board named {name} and save it', { params: { name } });
  await expect(screen.getByText(name).first()).toBeVisible();
});
