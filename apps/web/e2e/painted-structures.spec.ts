/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries, syntheticThoraxPatient } from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  answerNext,
  expectNoProblems,
  preAcknowledge,
  requireWebGpu,
  watchProblems,
} from './fixtures/app';
import { capturedColour } from './fixtures/capture';
import { importAndLoad } from './fixtures/load';

// Painted structures in the Structures list: shown, hidden, faded, recoloured,
// renamed and deleted there; and an imported structure copied to a painted one.

/** Move a slider or a colour field to a value the way a user's change does. */
async function setValue(input: Locator, value: string | number): Promise<void> {
  await input.evaluate((element, v) => {
    (element as HTMLInputElement).value = String(v);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const painted = (page: Page) => page.locator('app-painted-structures');
/** The two selectors of the Edit structures panel: what the brush paints into, and in which set. */
const activeStructure = (page: Page) =>
  page.getByRole('combobox', { name: 'Active structure', exact: true });
const activeSet = (page: Page) =>
  page.getByRole('combobox', { name: 'Active structure set', exact: true });

async function open(page: Page, files: Parameters<typeof importAndLoad>[1]): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  await importAndLoad(page, files);
}

/** One stamp of the brush on the main pane, at a fraction of its size. */
async function stamp(page: Page, fx: number, fy: number): Promise<void> {
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy);
  await page.mouse.down();
  await page.mouse.up();
}

test('a painted structure is listed, and can be hidden, faded, recoloured, renamed and deleted', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page, syntheticCtSeries(12, 32));
  // Capture the image alone, to measure how much colour the structure puts in it.
  await page.getByRole('button', { name: /^Overlays/ }).click();
  // No structures of either kind: no list.
  await expect(page.getByRole('group', { name: 'Structures', exact: true })).toHaveCount(0);

  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  await stamp(page, 0.45, 0.45);

  // It is in the list, in its set, with the controls an imported structure has.
  const rows = painted(page).locator('.row');
  await expect(rows).toHaveCount(1);
  await expect(painted(page).locator('.set-label')).toHaveText('Structures');
  const name = page.getByLabel('Name of Structure 1 (painted)');
  await expect(name).toHaveValue('Structure 1');
  const visible = page.getByLabel('Show Structure 1 (painted)');
  await expect(visible).toBeChecked();
  const full = await capturedColour(page);
  expect(full).toBeGreaterThan(1);

  // Hidden and shown again; the voxels are not touched.
  await visible.uncheck();
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await visible.check();
  expect(await capturedColour(page)).toBeCloseTo(full, 1);

  // Its own opacity: half as strong at 50%.
  await setValue(page.getByLabel('Structure 1 opacity (painted)'), 50);
  const half = await capturedColour(page);
  expect(half / full).toBeGreaterThan(0.4);
  expect(half / full).toBeLessThan(0.6);
  await setValue(page.getByLabel('Structure 1 opacity (painted)'), 100);

  // Recoloured to grey, it adds no colour to a grey image; back to red, it does.
  await setValue(page.getByLabel('Structure 1 colour (painted)'), '#808080');
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await setValue(page.getByLabel('Structure 1 colour (painted)'), '#ff0000');
  expect(await capturedColour(page)).toBeGreaterThan(1);

  // Renamed: here, and where the brush chooses what to paint into.
  await name.fill('Liver');
  await name.press('Enter');
  await expect(page.getByLabel('Name of Liver (painted)')).toHaveValue('Liver');
  await expect(activeStructure(page).locator('option')).toHaveText(['Liver']);
  // An empty name is not taken.
  await page.getByLabel('Name of Liver (painted)').fill('   ');
  await page.getByLabel('Name of Liver (painted)').press('Enter');
  await expect(page.getByLabel('Name of Liver (painted)')).toHaveValue('Liver');

  // Delete asks first, and says what goes. Declined, nothing changes.
  const declined = answerNext(page, false);
  await page.getByRole('button', { name: 'Delete Liver' }).click();
  expect(await declined).toBe(
    'Delete Liver? What was painted is removed and cannot be brought back.',
  );
  await expect(rows).toHaveCount(1);
  expect(await capturedColour(page)).toBeGreaterThan(1);

  // Accepted: gone from the list and from the image, and the brush stops painting.
  const accepted = answerNext(page, true);
  await page.getByRole('button', { name: 'Delete Liver' }).click();
  await accepted;
  await expect(rows).toHaveCount(0);
  await expect(painted(page).locator('.none')).toHaveText('No structures in this set yet.');
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await expect(activeStructure(page).locator('option')).toHaveText(['No structures yet']);
  await expect(page.getByRole('button', { name: /Paint/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expectNoProblems(problems);
});

test('a painted set can be deleted with what is in it', async ({ page }) => {
  const problems = watchProblems(page);
  await open(page, syntheticCtSeries(12, 32));
  await page.getByRole('button', { name: /^Overlays/ }).click();

  // Two sets: the first with one structure, the second with two.
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  await stamp(page, 0.3, 0.3);
  await page.getByRole('button', { name: '＋ Set' }).click();
  await page.getByTitle('Create a new structure and paint it').click();
  await stamp(page, 0.6, 0.6);
  await page.getByTitle('Create a new structure and paint it').click();
  await stamp(page, 0.7, 0.4);
  await expect(painted(page).locator('.set-label')).toHaveText(['Structures', 'Structures 2']);
  await expect(painted(page).locator('.row')).toHaveCount(3);
  const three = await capturedColour(page);

  const asked = answerNext(page, true);
  await page.getByRole('button', { name: 'Delete the set Structures 2' }).click();
  expect(await asked).toBe(
    'Delete the set Structures 2 and the 2 structures in it? What was painted is removed and cannot be brought back.',
  );
  await expect(painted(page).locator('.set-label')).toHaveText(['Structures']);
  await expect(painted(page).locator('.row')).toHaveCount(1);
  // Its two stamps are out of the image; the first set's is still there.
  const one = await capturedColour(page);
  expect(one).toBeGreaterThan(1);
  expect(one).toBeLessThan(three * 0.6);
  // The brush is back on the set that is left, and its structure.
  await expect(activeSet(page)).toHaveValue(/\d+/);
  await expect(activeSet(page).locator('option')).toHaveText(['Structures']);
  await expect(activeStructure(page).locator('option')).toHaveText(['Structure 1']);

  // The last set: with it gone there is nothing to list.
  const last = answerNext(page, true);
  await page.getByRole('button', { name: 'Delete the set Structures' }).click();
  expect(await last).toContain('Delete the set Structures and the structure in it?');
  await expect(painted(page)).toHaveCount(0);
  expect(await capturedColour(page)).toBeLessThan(0.5);
  await expect(page.getByRole('button', { name: /export rtstruct/i })).toBeDisabled();
  expectNoProblems(problems);
});

test('an imported structure can be copied to a painted one to edit', async ({ page }) => {
  const problems = watchProblems(page);
  await open(page, syntheticThoraxPatient());
  await page.getByRole('button', { name: /^Overlays/ }).click();
  const before = await capturedColour(page);
  expect(before).toBeLessThan(0.5);

  const edit = page.getByRole('button', { name: 'Edit a copy of Lung_R' });
  const imported = page.getByLabel('Show Lung_R', { exact: true });
  await expect(imported).not.toBeChecked(); // imported structures start hidden
  await edit.click();

  // The copy is listed as painted, under the imported structure's name, and is
  // what the brush paints into now.
  await expect(painted(page).locator('.set-label')).toHaveText('New ROIs');
  await expect(page.getByLabel('Name of Lung_R (painted)')).toHaveValue('Lung_R');
  await expect(painted(page).locator('.row.active')).toHaveCount(1);
  await expect(activeStructure(page).locator('option')).toHaveText(['Lung_R']);
  // It is in the image: the lung is filled in the structure's colour.
  expect(await capturedColour(page)).toBeGreaterThan(before + 1);
  // The imported one is hidden, and cannot be copied a second time.
  await expect(imported).not.toBeChecked();
  await expect(edit).toBeDisabled();

  // Hidden, not changed: shown again, its outline is drawn as before.
  await imported.check();
  await expect(page.locator('svg.contours').first().locator('.contour')).toHaveCount(1);
  expectNoProblems(problems);
});
