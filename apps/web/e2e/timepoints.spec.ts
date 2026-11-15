/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE as COURSE,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles } from './fixtures/load';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// Timepoints (#39): a patient's studies grouped under names a user gives.
// The synthetic course has a planning study of 5 January and a follow-up
// study of 16 March. Nobody has grouped them, so they are grouped by date;
// then they are grouped by hand, and the grouping is there after a reload.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const BY_DATE = [
  { name: '2026-01-05', automatic: true, studies: [COURSE.planningStudy] },
  { name: '2026-03-16', automatic: true, studies: [COURSE.followUpStudy] },
];
const GROUPED = [
  { name: 'Follow-up', automatic: false, studies: [COURSE.followUpStudy] },
  { name: 'Planning', automatic: false, studies: [COURSE.planningStudy] },
];

/** The groups on the timeline, as they are shown: each name, whether nobody made it, and its studies. */
const groups = (page: Page) =>
  page.locator('.timeline .timepoint').evaluateAll((all) =>
    all.map((group) => ({
      name: group.querySelector('.timepoint-name')!.textContent.trim(),
      automatic: group.classList.contains('automatic'),
      studies: [...group.querySelectorAll<HTMLElement>('.study-tile')].map(
        (tile) => tile.dataset['studyUid'],
      ),
    })),
  );
const editor = (page: Page): Locator => page.locator('app-timepoint-editor');
const row = (page: Page, at: number): Locator =>
  editor(page).locator('[data-timepoint-row]').nth(at);
const placeOf = (page: Page, studyUid: string): Locator =>
  editor(page).locator(`[data-timepoint-study="${studyUid}"] select`);

/** Make a timepoint, name it, and put a study in it. */
async function make(page: Page, name: string, studyUid: string): Promise<void> {
  const before = await editor(page).locator('[data-timepoint-row]').count();
  await editor(page).locator('[data-timepoints="add"]').click();
  await expect(editor(page).locator('[data-timepoint-row]')).toHaveCount(before + 1);
  const field = row(page, before).locator('input');
  await field.fill(name);
  await field.press('Enter');
  await placeOf(page, studyUid).selectOption({ label: name });
}

/** Group the course by hand: Planning, then Follow-up, and Follow-up moved before it. */
async function groupByHand(page: Page): Promise<void> {
  await expect.poll(() => groups(page)).toEqual(BY_DATE);
  await page.locator('[data-timepoints="edit"]').click();
  await expect(editor(page).locator('.hint')).toHaveText(
    'None yet: the studies are grouped by study date.',
  );
  await make(page, 'Planning', COURSE.planningStudy);
  // The follow-up study is in no timepoint yet, and stays under its date, after what was made.
  await expect
    .poll(() => groups(page))
    .toEqual([{ name: 'Planning', automatic: false, studies: [COURSE.planningStudy] }, BY_DATE[1]]);
  await make(page, 'Follow-up', COURSE.followUpStudy);
  await row(page, 1).getByRole('button', { name: 'Move Follow-up earlier' }).click();
  await expect.poll(() => groups(page)).toEqual(GROUPED);
  await expect(editor(page).locator('[data-timepoints="problem"]')).toHaveCount(0);
  await editor(page).locator('[data-timepoints="done"]').click();
  await expect(editor(page)).toHaveCount(0);
}

test('studies are grouped by date, then into named timepoints that are there after a reload', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, syntheticRtCourse(32));
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await groupByHand(page);

  // Each group has its name over its studies and a rule where it begins.
  const first = page.locator('.timeline .timepoint').first();
  await expect(first.locator('.timepoint-name')).toHaveAttribute('title', 'Timepoint “Follow-up”');
  expect(await first.evaluate((group) => getComputedStyle(group).borderLeftWidth)).toBe('1px');
  const [name, tile] = await Promise.all([
    first.locator('.timepoint-name').boundingBox(),
    first.locator('.study-tile').boundingBox(),
  ]);
  expect(name!.y + name!.height).toBeLessThanOrEqual(tile!.y);
  // The registration still joins its two studies, whichever way round they now are.
  await expect(page.locator('.link-lines path')).toHaveCount(1);

  // Loaded again, with the same files opened again: grouped as it was left.
  await page.reload();
  await importFiles(page, syntheticRtCourse(32));
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  await expect.poll(() => groups(page)).toEqual(GROUPED);

  // A timepoint that is deleted leaves its study to its date again, and that is kept too.
  await page.locator('[data-timepoints="edit"]').click();
  await row(page, 0).getByRole('button', { name: 'Delete Follow-up' }).click();
  await expect.poll(() => groups(page)).toEqual([GROUPED[1], BY_DATE[1]]);
  await page.reload();
  await importFiles(page, syntheticRtCourse(32));
  await expect.poll(() => groups(page), { timeout: 30_000 }).toEqual([GROUPED[1], BY_DATE[1]]);
  expectNoProblems(problems);
});

test('a server keeps a patient’s timepoints for whoever opens the patient next', async ({
  page,
}) => {
  const server = await startTestServer([PAGE_ORIGIN]);
  try {
    await server.upload(syntheticRtCourse(32));
    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await requireWebGpu(page);
    const open = async (): Promise<void> => {
      const card = await connectTo(page, server.address, 'empty state');
      await studyRows(card).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
      await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
    };
    await open();
    await groupByHand(page);

    // The page is loaded again and knows nothing; the server does.
    await page.reload();
    await open();
    await expect.poll(() => groups(page)).toEqual(GROUPED);
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
