/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  frameOfReferenceUid,
  seriesUid,
  syntheticCtSeries,
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  syntheticRtCourse,
  syntheticRtStruct,
  SYNTHETIC_STUDY,
  type SyntheticStudy,
  syntheticThoraxPatient,
  THORAX_PATIENT,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import {
  answerNext,
  expectNoProblems,
  preAcknowledge,
  requireWebGpu,
  watchProblems,
} from './fixtures/app';
import { importFiles, pickSeries, seriesChip } from './fixtures/load';

// Files of several patients open at once (#35): both are listed, the viewer
// is of one, and turning to the other empties it first.

const THORAX = syntheticThoraxPatient({ size: 48, slices: 16 });
const COURSE = syntheticRtCourse();

/** The status line with the course's CT loaded: as many slices as the generator says it writes. */
const COURSE_CT = new RegExp(`volume \\d+ × \\d+ × ${SYNTHETIC_RT_COURSE.ctSlices}\\.`);

const label = (patient: { name: string; id: string }): string => `${patient.name} (${patient.id})`;

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

// Closing (#208): the patient leaves the list, and what was on screen with them.
test('a patient can be closed, down to the empty state', async ({ page }) => {
  await open(page);
  await importFiles(page, [...THORAX, ...COURSE]);
  const close = page.getByRole('button', { name: 'Close patient' });
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText(COURSE_CT);

  // A series of theirs is showing, so it asks. Refused: nothing changes.
  let asked = answerNext(page, false);
  await close.click();
  expect(await asked).toContain(`Close ${SYNTHETIC_PATIENT.name} and empty the viewer?`);
  await expect(page.locator('div.status')).toContainText(COURSE_CT);
  expect((await offered(page)).options).toHaveLength(2);

  // Agreed: the other patient is the one left, named in plain text, and the panes are empty.
  asked = answerNext(page, true);
  await close.click();
  await asked;
  await expect(selector(page)).toHaveCount(0);
  await expect(page.locator('.history-patient')).toHaveText(THORAX_PATIENT.name);
  await expect(page.locator('.notice')).toContainText(`Closed ${SYNTHETIC_PATIENT.name}.`);
  await expect(page.locator('div.status')).not.toContainText('volume');
  await expect(page.locator('.pane-tag').first()).toHaveText(/Axial · –/);
  await expect(page.locator('.study-tile').first()).toContainText('Synthetic thorax planning');

  // Nothing is showing, so the last one closes without a question, and the viewer is as it began.
  await close.click();
  await expect(page.locator('app-history-panel')).toBeHidden();
  await expect(page.locator('app-empty-state')).toBeVisible();

  // Their files open them again.
  await importFiles(page, COURSE);
  await expect(page.locator('.history-patient')).toHaveText(SYNTHETIC_PATIENT.name);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText(COURSE_CT);
});

// One study exported under two names shares every UID. A structure set says
// whose it is, and is not drawn on the series of anyone else (#208).
test('a structure set of one open patient does not join a series of another', async ({ page }) => {
  const pseudonym = { id: 'SYN-0099', name: 'SYNTHETIC^PSEUDONYM' };
  const relabelled: SyntheticStudy = { ...SYNTHETIC_STUDY, patient: pseudonym };
  // The same frame of reference, since the study is the same one.
  expect(frameOfReferenceUid(relabelled)).toBe(frameOfReferenceUid(SYNTHETIC_STUDY));
  const theirOwn: SyntheticStudy = { ...SYNTHETIC_STUDY, index: 9, patient: pseudonym };
  const ct = seriesUid(SYNTHETIC_STUDY, 1);

  await open(page);
  await importFiles(page, [
    // The first patient: a CT, and a set of two structures drawn on it.
    ...syntheticCtSeries(12, 32),
    syntheticRtStruct(12, 2, { referencedSeriesUid: ct }),
    // The second: a set of three in the same frame, naming the same CT, and a CT of their own.
    syntheticRtStruct(12, 3, { study: relabelled, referencedSeriesUid: ct }),
    ...syntheticCtSeries(12, 32, { study: theirOwn }),
  ]);
  expect((await offered(page)).on).toBe(label(SYNTHETIC_PATIENT));

  // The first patient's CT comes with one set, of two structures.
  const chip = await seriesChip(page, 'CT');
  await expect(chip.locator('.chip-sets [aria-hidden]')).toHaveText('RS 1');
  await pickSeries(page, 'CT');
  await expect(page.locator('.roi-legend .roi-item')).toHaveCount(2);

  // The second patient's CT is in another frame, and comes with none.
  const asked = answerNext(page, true);
  await selector(page).selectOption({ label: label(pseudonym) });
  await asked;
  await expect.poll(async () => (await offered(page)).on).toBe(label(pseudonym));
  const theirs = await seriesChip(page, 'CT');
  // The chip is there, and says nothing of structure sets.
  await expect(theirs).toContainText('12 img');
  await expect(theirs.locator('.chip-sets')).toHaveCount(0);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 32 × 32 × 12');
  await expect(page.locator('.roi-legend .roi-item')).toHaveCount(0);
});
