import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

// the board layout chooser that pr #2 added. the header "Layout" button opens a picker
// with four options; each option is a pressable whose accessibility label is the layout
// name and whose selected state reflects the saved preference.

test('the boards switch to compact rows from the layout chooser', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('open-board-layout').tap();
  await expect(screen.getByTestId('board-layout-picker')).toBeVisible();
  await screen.getByLabel('Compact rows').tap();
  await expect(screen.getByLabel('Compact rows')).toBeSelected();
  await screen.getByTestId('done-board-layout').tap();
  await expect(screen.getByTestId('board-layout-picker')).not.toBeVisible();
});

test('the boards switch to the two-column grid in plain english', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('open the layout chooser, pick the two-column grid layout, then tap done');
  await expect(screen.getByTestId('board-layout-picker')).not.toBeVisible();
  // reopen the chooser to pin the result: the saved choice is the grid.
  await screen.getByTestId('open-board-layout').tap();
  await expect(screen.getByLabel('Two-column grid')).toBeSelected();
  await screen.getByTestId('done-board-layout').tap();
});
