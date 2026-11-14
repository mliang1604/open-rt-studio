/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  syntheticRtCourse,
  syntheticThoraxPatient,
  THORAX_PATIENT,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles, pickSeries } from './fixtures/load';

// Files of several patients open at once (#35): both are listed, the viewer
// is of one, and turning to the other empties it first.

const THORAX = syntheticThoraxPatient({ size: 48, slices: 16 });
const COURSE = syntheticRtCourse();

/** The status line with the course's CT loaded: as many slices as the generator says it writes. */
const COURSE_CT = new RegExp(`volume \\d+ × \\d+ × ${SYNTHETIC_RT_COURSE.ctSlices}\\.`);

const label = (patient: { name: string; id: string }): string => `${patient.name} (${patient.id})`;

/** Answer the next question the page asks, and say what it asked. */
function answerNext(page: Page, accept: boolean): Promise<string> {
  return new Promise((resolve) => {
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void (accept ? dialog.accept() : dialog.dismiss());
    });
  });
}

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

const selector = (page: Page) => page.getByLabel('Patient', { exact: true });
/** The names of the patients the selector offers, and the one it is on. */
async function offered(page: Page): Promise<{ options: string[]; on: string }> {
  return selector(page).evaluate((select: HTMLSelectElement) => ({
    options: [...select.options].map((option) => option.textContent.trim()),
    on: select.selectedOptions[0]?.textContent.trim() ?? '',
  }));
}

// The issue's "done when", both parts.
test('a folder with two patients lists both, and switching swaps the timeline and clears the panes', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await open(page);

  // One batch, as a folder that holds two patients gives. They are listed by
  // Patient ID, and the timeline is of the first, whatever order the files came in.
  await importFiles(page, [...THORAX, ...COURSE]);
  await expect(page.locator('.notice')).toContainText('2 patients are open');
  expect(SYNTHETIC_PATIENT.id < THORAX_PATIENT.id).toBe(true);
  expect(await offered(page)).toEqual({
    options: [label(SYNTHETIC_PATIENT), label(THORAX_PATIENT)],
    on: label(SYNTHETIC_PATIENT),
  });
  const tiles = page.locator('.study-tile');
  await expect(tiles).toHaveCount(2);
  for (const text of await tiles.allInnerTexts()) expect(text).not.toContain('thorax');

  // Their CT, known by its number of slices.
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText(COURSE_CT);
  const courseTimeline = await tiles.allInnerTexts();

  // Turning to the other patient is asked first, because a series is showing. Refused: nothing changes.
  let asked = answerNext(page, false);
  await selector(page).selectOption({ label: label(THORAX_PATIENT) });
  expect(await asked).toContain(`Turn to ${THORAX_PATIENT.name} and empty the viewer?`);
  expect((await offered(page)).on).toBe(label(SYNTHETIC_PATIENT));
  await expect(page.locator('div.status')).toContainText(COURSE_CT);
  expect(await tiles.allInnerTexts()).toEqual(courseTimeline);

  // Agreed: the timeline is the other patient's, and the panes are empty.
  asked = answerNext(page, true);
  await selector(page).selectOption({ label: label(THORAX_PATIENT) });
  await asked;
  await expect.poll(async () => (await offered(page)).on).toBe(label(THORAX_PATIENT));
  await expect(tiles.first()).toContainText('Synthetic thorax planning');
  for (const text of await tiles.allInnerTexts()) expect(text).toContain('thorax');
  await expect(page.locator('div.status')).not.toContainText('volume');
  await expect(page.locator('.pane-tag').first()).toHaveText(/Axial · –/);
  await expect(page.locator('.roi-legend .roi-name')).toHaveCount(0);
  await expect(page.locator('app-series-chip.loaded')).toHaveCount(0);

  // Their series loads, and is theirs: the thorax CT is 48 by 48 in 16 slices.
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');

  // And back: the first patient was kept, with their timeline as it was.
  asked = answerNext(page, true);
  await selector(page).selectOption({ label: label(SYNTHETIC_PATIENT) });
  await asked;
  await expect.poll(() => tiles.allInnerTexts()).toEqual(courseTimeline);
  await expect(page.locator('div.status')).not.toContainText('volume');
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText(COURSE_CT);

  expectNoProblems(problems);
});

test('opening another patient keeps the first, and asks before it turns to the new one', async ({
  page,
}) => {
  await open(page);
  await importFiles(page, THORAX);
  // One patient: named in plain text, with nothing to choose.
  await expect(page.locator('.history-patient')).toHaveText(THORAX_PATIENT.name);
  await expect(selector(page)).toHaveCount(0);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');

  // Refused: nothing of the other patient is taken in.
  let asked = answerNext(page, false);
  await importFiles(page, COURSE);
  expect(await asked).toContain('These files belong to another patient.');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');
  await expect(selector(page)).toHaveCount(0);

  // Agreed: the viewer turns to them and is emptied, and the first stays in the list.
  asked = answerNext(page, true);
  await importFiles(page, COURSE);
  expect(await asked).toContain('The patient open now stays in the patient list.');
  await expect.poll(async () => (await offered(page)).on).toBe(label(SYNTHETIC_PATIENT));
  expect((await offered(page)).options).toEqual([label(SYNTHETIC_PATIENT), label(THORAX_PATIENT)]);
  await expect(page.locator('div.status')).not.toContainText('volume');

  // More files of the patient on screen, with nothing showing: no question.
  await importFiles(page, COURSE);
  expect((await offered(page)).on).toBe(label(SYNTHETIC_PATIENT));

  // Nothing is showing, so turning back asks nothing.
  await selector(page).selectOption({ label: label(THORAX_PATIENT) });
  await expect.poll(async () => (await offered(page)).on).toBe(label(THORAX_PATIENT));
  await expect(page.locator('.study-tile').first()).toContainText('Synthetic thorax planning');

  // Nor does opening the other patient's files again: there is nothing on screen to give up.
  await importFiles(page, COURSE);
  await expect.poll(async () => (await offered(page)).on).toBe(label(SYNTHETIC_PATIENT));
  expect((await offered(page)).options).toHaveLength(2);
});
