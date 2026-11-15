/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_LATIN1_PATIENT,
  SYNTHETIC_UTF8_PATIENT,
  characterSetStudy,
  syntheticCharacterSetPatient,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles, pickSeries } from './fixtures/load';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// Names outside ASCII (#249). The synthetic patients' files are written in
// UTF-8 (ISO_IR 192) and in Latin-1 (ISO_IR 100), and declare it; the
// viewer, and the server, show the names as they were written.

const SLICES = 6;

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

test('opened files show a name in UTF-8 and one in Latin-1 as they were written', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);
  await importFiles(page, [
    ...syntheticCharacterSetPatient(SYNTHETIC_UTF8_PATIENT, SLICES, 32),
    ...syntheticCharacterSetPatient(SYNTHETIC_LATIN1_PATIENT, SLICES, 32),
  ]);
  const selector = page.getByLabel('Patient', { exact: true });
  await expect(selector).toBeVisible({ timeout: 30_000 });
  const options = await selector.evaluate((select: HTMLSelectElement) =>
    [...select.options].map((option) => option.textContent.trim()),
  );
  expect(options).toEqual([
    `${SYNTHETIC_LATIN1_PATIENT.name} (${SYNTHETIC_LATIN1_PATIENT.id})`,
    `${SYNTHETIC_UTF8_PATIENT.name} (${SYNTHETIC_UTF8_PATIENT.id})`,
  ]);
  // The timeline of the UTF-8 patient: their name, and their study's description.
  await selector.selectOption({ label: options[1] });
  await expect(page.locator('.history-patient')).toContainText(SYNTHETIC_UTF8_PATIENT.name);
  await expect(page.locator('.study-tile')).toContainText(
    characterSetStudy(SYNTHETIC_UTF8_PATIENT).description,
  );
  // Opened, the image is theirs, and its structures come with it.
  await pickSeries(page, 'CT');
  await expect(page.locator('.roi-legend .roi-name')).not.toHaveCount(0, { timeout: 30_000 });
  expectNoProblems(problems);
});

test('a server lists, finds and opens a patient whose name is outside ASCII', async ({ page }) => {
  const origin = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
  const server = await startTestServer([origin]);
  try {
    await server.upload(syntheticCharacterSetPatient(SYNTHETIC_UTF8_PATIENT, SLICES, 32));
    const problems = watchProblems(page);
    await open(page);
    const card = await connectTo(page, server.address, 'empty state');
    // Found by a part of the name that is not ASCII.
    await card.getByLabel('Patient name').fill('山田');
    await card.getByRole('button', { name: 'Search', exact: true }).click();
    const row = studyRows(card);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.locator('.study-patient')).toHaveText(SYNTHETIC_UTF8_PATIENT.name);
    await row.click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.history-patient')).toContainText(SYNTHETIC_UTF8_PATIENT.name);
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
