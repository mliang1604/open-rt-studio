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
import { fuseChipByDrag } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { openServerCard, studyRows } from './fixtures/server-card';

// A registration kept on a server places a series over one of another frame
// of reference, as one opened from files does (#228): the server lists the
// registrations that name a series' frame with the series, the viewer fetches
// and reads them, and the fetch is in the audit log like any other.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const ADMIN = { name: 'ada', password: 'correct horse battery staple' };

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN], { account: ADMIN });
  const pair = syntheticRegisteredPair();
  await server.upload([...pair.planningCt, ...pair.followUpMr, pair.registration]);
});
test.afterAll(async () => {
  await server.stop();
});

const card = (page: Page) => page.locator('app-server-panel');

/** The chip of the series of a modality, in whichever study has it; the study is opened. */
async function chipOf(page: Page, modality: string): Promise<Locator> {
  const tile = page
    .locator('.study-tile')
    .filter({ has: page.locator('.modality-badge', { hasText: new RegExp(`^${modality}$`) }) })
    .first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const chip = page
    .locator('app-series-chip')
    .filter({ has: page.locator('.chip-modality', { hasText: new RegExp(`^${modality}$`) }) })
    .first();
  await expect(chip).toBeVisible();
  return chip;
}

test('a registration on the server places a series of another frame, and its fetch is in the audit log', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);

  await openServerCard(page, 'empty state');
  await card(page).getByLabel('Address of an Open RT Studio server').fill(server.address);
  await card(page).getByRole('button', { name: 'Connect' }).click();
  await card(page).getByLabel('Name').fill(ADMIN.name);
  await card(page).getByLabel('Password').fill(ADMIN.password);
  await card(page).getByRole('button', { name: 'Log in', exact: true }).click();
  await studyRows(card(page)).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });

  // The planning CT, then the follow-up MR ⌥-dragged onto it.
  const ct = await chipOf(page, 'CT');
  const layout = page.getByRole('button', { name: /layout/i });
  await expect(async () => {
    await ct.click();
    await expect(layout).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.locator('div.status')).toContainText(
    `volume ${PAIR.size} × ${PAIR.size} × ${PAIR.count}`,
  );
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.layer-panel [data-placement]')).toHaveText(
    'Placed by registration “REGISTRATION” (written this image → base)',
  );

  // The probe reads the MR where the registration puts it, as from files.
  const pane = page.locator('.pane-overlay .pane').first();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.55);
  const probe = page.locator('.probe');
  await expect(probe).toBeVisible();
  const text = await probe.innerText();
  const match = /voxel \((\d+), (\d+), (\d+)\).* · value (-?\d+) HU · MR (-?\d+)$/.exec(text);
  expect(match, `unexpected probe text: ${text}`).not.toBeNull();
  const [x, y, z, ctValue, mrValue] = match!.slice(1).map(Number);
  expect(ctValue).toBe(syntheticCtValue(x, z, PAIR.size));
  expect(mrValue).toBe(registeredMrValueAtCtVoxel(x, y, z));

  // The audit log has a record for the registration's file: a download from
  // the series it is filed in, by who was logged in, of this patient.
  await openServerCard(page, 'history');
  await card(page).getByRole('button', { name: 'Audit log' }).click();
  const download = card(page)
    .locator('app-audit-panel tbody tr')
    .filter({ hasText: 'instance-download' })
    .filter({
      has: page.locator(`.audit-target[title^="Series ${PAIR.registrationSeries} "]`),
    });
  await expect(download).toHaveCount(1);
  await expect(download.locator('.audit-who')).toHaveText(ADMIN.name);
  await expect(download.locator('.audit-patient')).toHaveText(SYNTHETIC_PATIENT.id);
  await expect(download.locator('.audit-outcome')).toHaveText('ok');

  expectNoProblems(problems);
});
