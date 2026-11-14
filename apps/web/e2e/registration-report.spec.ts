/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';

import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  syntheticDeformableRegistration,
  syntheticRegisteredPair,
  syntheticRtStruct,
} from '@open-rt-studio/testdata';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { fuseChipByDrag, importFiles } from './fixtures/load';
import { chipOf, showCt } from './fixtures/registered-pair';

// The registration report (#87): one HTML file with the two images, the
// registration, pictures of the panes, and every number that was measured in
// the viewer. Made here for the synthetic pair placed by its deformable
// registration, with its rigid registration as the way back, two structures
// compared and a landmark placed: every kind of measurement there is.

const reportPanel = (page: Page): Locator => page.locator('app-report-panel');

/** The lines of every table under a place: a name and a value each. */
async function tableRows(under: Locator): Promise<string[][]> {
  return under
    .locator('tbody tr')
    .evaluateAll((lines) =>
      lines.map((line) =>
        [...line.children].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
      ),
    );
}

/** Save the report and read the file the browser was handed. */
async function saveReport(page: Page): Promise<{ name: string; html: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    reportPanel(page).locator('[data-report-save]').click(),
  ]);
  return {
    name: download.suggestedFilename(),
    html: await readFile((await download.path())!, 'utf8'),
  };
}

/** Open a report as a file of its own, in a browser that knows nothing of the viewer. */
async function openReport(browser: Browser, html: string) {
  const context = await browser.newContext();
  const reader = await context.newPage();
  const complaints: string[] = [];
  reader.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') complaints.push(message.text());
  });
  reader.on('pageerror', (error) => complaints.push(String(error)));
  await reader.setContent(html);
  return { reader, complaints, close: () => context.close() };
}

test('a report of a synthetic registration holds every number that was measured', async ({
  page,
  browser,
}) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, [
    ...pair.planningCt,
    ...pair.followUpMr,
    pair.registration,
    syntheticDeformableRegistration(),
    syntheticRtStruct(PAIR.count),
  ]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  // A report is of a registration: there is none to make of one image.
  await expect(reportPanel(page)).toHaveCount(0);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  const choice = page.locator('.layer-panel select[data-placement-choice]');
  const deformable = choice.locator('option', { hasText: '(deformable)' });
  await choice.selectOption({
    index: await deformable.evaluate((option) => (option as HTMLOptionElement).index),
  });
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  // Nothing is measured yet, and the panel says so.
  await page.locator('details[aria-label="Registration report"] summary').click();
  const states = reportPanel(page).locator('[data-report-part] .state');
  await expect(states).toHaveText(['not measured', 'not measured', 'not measured']);

  // The field, with the rigid registration as the way back.
  const field = page.locator('app-field-metrics-panel');
  await field.locator('[data-field-measure]').click();
  await expect(field.locator('[data-field-consistency]')).toBeVisible();
  // Two structures.
  const structures = page.locator('app-structure-compare');
  await structures.getByRole('button', { name: 'Compare' }).click();
  await expect(structures.locator('table')).toHaveCount(1);
  // A landmark: the same place clicked in the CT's column and in the MR's.
  const landmarks = page.locator('app-landmark-panel');
  await landmarks.locator('[data-landmark-place]').click();
  const panes = page.locator('.pane-overlay .pane');
  await expect(panes).toHaveCount(6);
  for (const pane of [panes.nth(0), panes.nth(3)]) {
    const box = (await pane.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
  }
  await expect(landmarks.locator('table')).toHaveCount(1);
  await landmarks.locator('[data-landmark-place]').click();
  await expect(states).toHaveText(['measured', 'measured', 'measured']);

  // What the panels show now.
  const shown = {
    landmarks: await tableRows(landmarks),
    structures: await tableRows(structures),
    field: await tableRows(field),
  };
  expect(shown.landmarks.length).toBeGreaterThanOrEqual(4);
  expect(shown.structures).toHaveLength(6);
  // Jacobian determinant, displacement, there and back.
  expect(shown.field.length).toBeGreaterThanOrEqual(12);
  const fieldNotes = await field.locator('p').allInnerTexts();
  const paneCount = await panes.count();

  // Identifiers are left out unless asked for.
  await expect(reportPanel(page).locator('[data-report-identifiers-toggle]')).not.toBeChecked();
  const plain = await saveReport(page);
  expect(plain.name).toMatch(/^registration-report-\d{8}-\d{6}\.html$/);
  // One file that runs nothing and fetches nothing.
  expect(plain.html).not.toMatch(/<script|<link|<iframe/i);
  expect(plain.html).toContain(
    `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`,
  );

  const { reader, complaints, close } = await openReport(browser, plain.html);
  // Not for clinical use, at the head and the foot of every page.
  await expect(reader.locator('table.pages > thead [data-report-notice]')).toContainText(
    'Not for clinical use',
  );
  await expect(reader.locator('table.pages > tfoot [data-report-notice]')).toContainText(
    'Not for clinical use',
  );
  // Every number of every panel, under its own heading.
  for (const [key, rows] of Object.entries(shown)) {
    const section = reader.locator(`[data-report="${key}"]`);
    await expect(section).toHaveAttribute('data-state', 'measured');
    const reported = await tableRows(section);
    for (const row of rows) expect(reported, `${key}: ${row.join(' ')}`).toContainEqual(row);
  }
  // The landmark itself, with its error.
  const landmark = landmarks.locator('[data-landmark-row]').first();
  const error = (await landmark.locator('.distance').innerText()).trim();
  expect(error).toMatch(/^\d+\.\d\d mm$/);
  const perLandmark = await tableRows(reader.locator('[data-report="landmarks"]'));
  expect(perLandmark.some(([name, value]) => name === 'L1' && value.startsWith(error))).toBe(true);
  // What the numbers cannot tell goes with them.
  const fieldSection = reader.locator('[data-report="field"]');
  for (const note of fieldNotes) {
    await expect(fieldSection).toContainText(note.replace(/\s+/g, ' ').trim());
  }
  await expect(fieldSection).toContainText('Consistent is not the same as accurate.');
  await expect(reader.locator('[data-report="landmarks"]')).toContainText(
    'Measured at 1 landmark only. Includes the error of placing them.',
  );
  await expect(reader.locator('[data-report="structures"]')).toContainText(
    'Includes the difference between the two delineations.',
  );
  // Which registration, which way, and the two images.
  const registration = reader.locator('[data-report="registration"]');
  await expect(registration).toContainText('Placed by deformable registration');
  expect(await tableRows(registration)).toEqual(
    expect.arrayContaining([
      ['Kind', 'Deformation field (DICOM Deformable Spatial Registration)'],
      ['Written', 'from the base image’s frame to the compared image’s frame'],
      ['Used', 'as written'],
      ['Maps', 'from the base image’s frame to the compared image’s'],
    ]),
  );
  expect(await tableRows(reader.locator('[data-report="images"]'))).toEqual([
    ['Modality', 'CT'],
    ['Size', `${PAIR.size} × ${PAIR.size} × ${PAIR.count} voxels of 1.00 × 1.00 × 1.00 mm`],
    ['Modality', 'MR'],
    ['Size', `${PAIR.size} × ${PAIR.size} × ${PAIR.count} voxels of 1.00 × 1.00 × 1.00 mm`],
  ]);
  // A picture of every pane, carried in the file and drawn.
  const pictures = reader.locator('[data-report="pictures"] img');
  await expect(pictures).toHaveCount(paneCount);
  const sizes = await pictures.evaluateAll((all) =>
    all.map((one) => [
      (one as HTMLImageElement).complete,
      (one as HTMLImageElement).naturalWidth > 16,
      (one as HTMLImageElement).src.startsWith('data:image/png;base64,'),
    ]),
  );
  for (const size of sizes) expect(size).toEqual([true, true, true]);
  expect(complaints).toEqual([]);

  // Nothing of the patient, the studies or the objects is in it.
  await expect(reader.locator('[data-report-identifiers]')).toHaveAttribute(
    'data-report-identifiers',
    'left-out',
  );
  const identifiers = [
    'SYNTHETIC',
    'PHANTOM',
    'SYN-0001',
    '2.25.',
    PAIR.ct,
    PAIR.mr,
    PAIR.planningFrame,
    PAIR.followUpFrame,
    '2026-01-05',
    '2026-03-16',
    'Synthetic planning study',
    'Synthetic follow-up study',
    'Synthetic CT ramp',
    'Synthetic MR blob',
  ];
  for (const identifier of identifiers) expect(plain.html, identifier).not.toContain(identifier);
  // A value, and what it was measured on; nothing says whether it is good.
  expect(await reader.locator('body').innerText()).not.toMatch(
    /pass|fail|accept|tolerance|within limits/i,
  );
  await close();

  // Asked for, the identifiers of both images and of the registration are in it.
  await reportPanel(page).locator('[data-report-identifiers-toggle]').check();
  await expect(reportPanel(page).locator('[data-report-identifiers-note]')).toContainText(
    'Guard it like the data.',
  );
  const named = await saveReport(page);
  const second = await openReport(browser, named.html);
  await expect(second.reader.locator('[data-report-identifiers]')).toHaveAttribute(
    'data-report-identifiers',
    'included',
  );
  const images = await tableRows(second.reader.locator('[data-report="images"]'));
  expect(images).toEqual(
    expect.arrayContaining([
      ['Patient’s name', 'SYNTHETIC^PHANTOM'],
      ['Patient ID', 'SYN-0001'],
      ['Study date', '2026-01-05'],
      ['Study date', '2026-03-16'],
      ['Series Instance UID', PAIR.ct],
      ['Series Instance UID', PAIR.mr],
      ['Frame of Reference UID', PAIR.planningFrame],
      ['Frame of Reference UID', PAIR.followUpFrame],
    ]),
  );
  const steps = await tableRows(second.reader.locator('[data-report="registration"]'));
  expect(
    steps.some(([name, value]) => name === 'SOP Instance UID' && value.startsWith('2.25.')),
  ).toBe(true);
  // The file's name says nothing of the patient either way.
  expect(named.name).toMatch(/^registration-report-\d{8}-\d{6}\.html$/);
  await second.close();
  expectNoProblems(problems);
});

test('a report says of what was not measured that it was not', async ({ page, browser }) => {
  const problems = watchProblems(page);
  const pair = syntheticRegisteredPair();
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await requireWebGpu(page);
  // The pair with its rigid registration alone: no field, no structures, no landmarks.
  await importFiles(page, [...pair.planningCt, ...pair.followUpMr, pair.registration]);
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await showCt(page);
  await fuseChipByDrag(page, await chipOf(page, 'MR'));
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });

  await page.locator('details[aria-label="Registration report"] summary').click();
  const { html } = await saveReport(page);
  const { reader, close } = await openReport(browser, html);
  for (const key of ['landmarks', 'structures', 'field']) {
    const section = reader.locator(`[data-report="${key}"]`);
    await expect(section).toHaveAttribute('data-state', 'none');
    await expect(section.locator('p')).toHaveText('Not measured.');
    await expect(section.locator('table')).toHaveCount(0);
  }
  // The registration is a matrix, written from the MR's frame to the CT's and used turned round.
  const registration = await tableRows(reader.locator('[data-report="registration"]'));
  expect(registration).toEqual(
    expect.arrayContaining([
      ['Kind', 'Matrix (DICOM Spatial Registration)'],
      ['Written', 'from the compared image’s frame to the base image’s frame'],
      ['Used', 'turned round'],
    ]),
  );
  // The base's frame to the MR's: the file's translation, the other way.
  const [x, y, z] = PAIR.translation.map((mm) => (-mm).toFixed(4));
  expect(registration).toEqual(
    expect.arrayContaining([
      ['Row 1', `1.0000 0.0000 0.0000 ${x}`],
      ['Row 2', `0.0000 1.0000 0.0000 ${y}`],
      ['Row 3', `0.0000 0.0000 1.0000 ${z}`],
    ]),
  );
  await expect(reader.locator('[data-report="pictures"] img')).toHaveCount(3);
  await close();
  expectNoProblems(problems);
});
