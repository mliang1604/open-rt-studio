/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticCtValue,
  syntheticRegisteredPair,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles } from './fixtures/load';
import { chipOf, probeAt } from './fixtures/registered-pair';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// The registration workflow (#82): from two series on the timeline to a
// registration that was looked at and kept, in the viewer. The server is the
// project's own, with stand-ins for the registration tools: they register
// nothing, and answer what a spec can know. The rigid one puts the moving
// image's first voxel on the fixed image's, so each MR voxel is over the CT
// voxel of the same index. That is not the pair's true registration (2, 3
// and 1 voxels from it), which is how the probe tells that the image is
// placed by what the job stored and by nothing else.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;

let server: TestServer;
// A server for each test: what one stores is not there for the next.
test.beforeEach(async () => {
  server = await startTestServer([PAGE_ORIGIN], { registrationTools: true });
  const pair = syntheticRegisteredPair();
  await server.upload([...pair.planningCt, ...pair.followUpMr]);
});
test.afterEach(async () => {
  await server.stop();
});

const panel = (page: Page): Locator => page.locator('app-registration-workflow');
const links = (page: Page): Locator => page.locator('app-registration-links .link');
const placedBy = (page: Page): Locator => page.locator(`.layer-panel [data-placement]`);

/** The synthetic patient of the server on the timeline, and the registration panel open. */
async function openPatient(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  const card = await connectTo(page, server.address);
  await studyRows(card).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await page.locator('[data-registration-group] > summary').click();
  await expect(panel(page)).toBeVisible();
}

/** Choose the planning CT as the fixed image and the follow-up MR as the moving one, on the timeline. */
async function pickPair(page: Page): Promise<void> {
  const banner = page.locator('app-history-panel [data-picking]');
  await panel(page).locator('[data-pick=fixed]').click();
  await expect(banner).toContainText('Click a series for the fixed image');
  await (await chipOf(page, 'CT')).click();
  // The moving image is asked for next, with nothing more to press.
  await expect(banner).toContainText('Click a series for the moving image');
  await (await chipOf(page, 'MR')).click();
  await expect(banner).toHaveCount(0);
  await expect(panel(page).locator('[data-end=fixed] .end-series')).toContainText('CT');
  await expect(panel(page).locator('[data-end=moving] .end-series')).toContainText('MR');
  // Each chip says what it was picked as.
  await expect((await chipOf(page, 'CT')).locator('.chip-mark')).toHaveText('Fixed');
  await expect((await chipOf(page, 'MR')).locator('.chip-mark')).toHaveText('Moving');
}

test('two series become a registration that is looked at, renamed and kept', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchProblems(page);
  await openPatient(page);

  // Nothing is on screen: the two series are chosen on the timeline, and nothing is loaded by it.
  await pickPair(page);
  await expect(page.getByRole('button', { name: /layout/i })).toBeDisabled();
  await expect(links(page)).toHaveCount(0);

  await panel(page).getByLabel('Automatic, rigid').check();
  await panel(page).locator('[data-registration=start]').click();

  // The server registers; the two images are opened together, placed by what it stored.
  const review = panel(page).locator('[data-step=review]');
  await expect(review).toHaveText('Registered. The moving image is placed by what was found.', {
    timeout: 60_000,
  });
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(panel(page)).toContainText('Nothing has checked this registration.');
  const name = panel(page).locator('[data-registration-name]');
  await expect(name).toHaveValue(/^Automatic rigid \d{4}-\d\d-\d\d \d\d:\d\d$/);
  await expect(placedBy(page)).toContainText('Placed by registration “Automatic rigid ');
  await expect(links(page)).toHaveCount(1);

  // The probe reads the MR where the stored registration puts it: index on index.
  const read = await probeAt(page, 0.45, 0.55);
  const [x, y, z] = read.voxel;
  expect(read.ct).toBe(syntheticCtValue(x, z, PAIR.size));
  expect(read.mr).toBe(registeredMrValueAtCtVoxel(x, y, z, [0, 0, 0]));
  expect(read.mr).not.toBe(registeredMrValueAtCtVoxel(x, y, z));

  // Looked at side by side, and fused again.
  await panel(page).getByRole('button', { name: 'Side by side' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(6);
  await panel(page).getByRole('button', { name: 'Fusion' }).click();
  await expect(page.locator('.pane-overlay .pane')).toHaveCount(3);

  // Kept under a name of one's own: one registration, under that name, and it is what places the image.
  await name.fill('Planning CT to follow-up MR');
  await panel(page).locator('[data-registration=accept]').click();
  await expect(page.locator('.notice')).toContainText(
    'Kept the registration as “Planning CT to follow-up MR”.',
    { timeout: 30_000 },
  );
  await expect(panel(page).locator('[data-registration=start]')).toBeVisible();
  await expect(placedBy(page)).toHaveText(
    'Placed by registration “Planning CT to follow-up MR” (written this image → base)',
    { timeout: 30_000 },
  );
  await expect(links(page)).toHaveCount(1);
  await expect(links(page)).toHaveAttribute(
    'title',
    /^Registration “Planning CT to follow-up MR”\. /,
  );
  const after = await probeAt(page, 0.45, 0.55);
  expect(after.mr).toBe(
    registeredMrValueAtCtVoxel(after.voxel[0], after.voxel[1], after.voxel[2], [0, 0, 0]),
  );

  expectNoProblems(problems);
});

test('a deformable registration is run with a preset, and discarded again', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchProblems(page);
  await openPatient(page);
  await pickPair(page);

  await panel(page).getByLabel('Automatic, deformable').check();
  // The preset named for the two kinds of image is offered first; another is chosen.
  const preset = panel(page).locator('[data-registration-preset]');
  await expect(preset).toHaveValue('mr-ct');
  await expect(preset.locator('option')).toHaveText(['Cone-beam CT to CT', 'CT to CT', 'MR to CT']);
  await preset.selectOption('ct-ct');
  await panel(page).locator('[data-registration=start]').click();

  await expect(panel(page).locator('[data-step=review]')).toHaveText(
    'Registered. The moving image is placed by what was found.',
    { timeout: 60_000 },
  );
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  // What the server said of the field it stored.
  await expect(panel(page).locator('.facts li')).toHaveText([
    'Preset ct-ct',
    'Field of 3 × 3 × 2 vectors',
    /^Longest vector \d+\.\d mm$/,
  ]);
  await expect(panel(page).locator('[data-registration-name]')).toHaveValue(
    /^Automatic deformable ct-ct /,
  );
  await expect(placedBy(page)).toContainText(
    'Placed by deformable registration “Automatic deformable ct-ct ',
  );
  await expect(links(page)).toHaveCount(1);
  await expect(links(page)).toHaveClass(/deformable/);

  // Discarded: the server no longer has it, and nothing places the moving image.
  await panel(page).locator('[data-registration=discard]').click();
  await expect(page.locator('.notice')).toContainText(
    /^Discarded the registration “Automatic deformable ct-ct .*”\. It was removed from the server\.$/,
    { timeout: 30_000 },
  );
  await expect(links(page)).toHaveCount(0);
  await expect(page.locator('.blend-bar')).toHaveCount(0);
  await expect(panel(page).locator('[data-registration=start]')).toBeVisible();
  // The two series are still the ones chosen.
  await expect(panel(page).locator('[data-end=moving] .end-series')).toContainText('MR');

  expectNoProblems(problems);
});

test('a registration that is running says so, and is cancelled', async ({ page }) => {
  const problems = watchProblems(page);
  await server.slowRegistrations(true);
  await openPatient(page);
  await pickPair(page);
  await panel(page).getByLabel('Automatic, rigid').check();
  await panel(page).locator('[data-registration=start]').click();

  // The tool says that it has begun, and how far it is.
  const running = panel(page).locator('[data-step=running]');
  await expect(running).toHaveText('Registering · 15%', { timeout: 30_000 });
  await expect(panel(page).locator('progress')).toHaveAttribute('value', '15');
  // Nothing else of the flow is offered meanwhile.
  await expect(panel(page).locator('[data-registration=start]')).toHaveCount(0);

  await panel(page).locator('[data-registration=cancel]').click();
  await expect(page.locator('.notice')).toHaveText(
    'The registration was cancelled. Nothing was stored.',
    { timeout: 30_000 },
  );
  await expect(panel(page).locator('[data-registration=start]')).toBeVisible();
  await expect(panel(page).locator('[data-registration-problem]')).toHaveCount(0);
  await expect(links(page)).toHaveCount(0);

  expectNoProblems(problems);
});

test('with opened files, the panel says where a registration is computed, and by hand works', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  const pair = syntheticRegisteredPair();
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await page.locator('[data-registration-group] > summary').click();

  await expect(panel(page).locator('[data-computing]')).toHaveText(
    'An automatic registration is computed by an Open RT Studio server that has the registration tools, not by this page. Connect to one with “Server…” on the history bar. The desktop application does not have the tools yet. By hand works here.',
  );
  await expect(panel(page).getByLabel('Automatic, rigid')).toBeDisabled();
  await expect(panel(page).getByLabel('Automatic, deformable')).toBeDisabled();
  await expect(panel(page).getByLabel('By hand')).toBeChecked();

  // By hand: the two are opened, and the moving image is in hand, middle on middle.
  await pickPair(page);
  await panel(page).locator('[data-registration=start]').click();
  await expect(panel(page).locator('[data-step=review]')).toContainText(
    'The moving image is in your hand',
    { timeout: 60_000 },
  );
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('app-manual-registration')).toBeVisible();
  await expect(panel(page).locator('[data-registration-state]')).toHaveText(
    'Not saved: it is in the viewer only until it is accepted.',
  );
  // Let go of: nothing is kept, and the panel is where it began.
  await panel(page).locator('[data-registration=discard]').click();
  await expect(panel(page).locator('[data-registration=start]')).toBeVisible();
  await expect(page.locator('app-manual-registration')).toHaveCount(0);
  await expect(links(page)).toHaveCount(0);

  expectNoProblems(problems);
});
