/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_PLAN_FRACTIONS as FRACTIONS,
  SYNTHETIC_PLAN_PRESCRIPTION_GY as PRESCRIBED,
  SYNTHETIC_PLAN_TARGET_ROI as TARGET_ROI,
  SYNTHETIC_RT_COURSE as COURSE,
  syntheticRois,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { importFiles } from './fixtures/load';
import { startTestServer } from './fixtures/server';
import { connectTo, studyRows } from './fixtures/server-card';

// Radiotherapy objects on the timeline (#38). The synthetic course is a
// planning study (a CT and an MR in one frame, a structure set that names
// the CT, a plan that names the structure set, a dose that names the plan)
// and a follow-up study (a CT in a frame of its own, and a registration that
// names both CTs). The timeline shows each with what it belongs to.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const PLANNING_CT = 'CT Synthetic CT ramp (2026-01-05)';
/** The structure the synthetic plan prescribes to, by the name its structure set gives it. */
const TARGET = syntheticRois(32).find((roi) => roi.number === TARGET_ROI)!.name;
const FOLLOW_UP_CT = 'CT Synthetic follow-up CT (2026-03-16)';

const chipOf = (page: Page, seriesUid: string): Locator =>
  page.locator(`.series-strip li[data-series-uid="${seriesUid}"]`);
const tileOf = (page: Page, studyUid: string): Locator =>
  page.locator(`.study-tile[data-study-uid="${studyUid}"]`);
const link = (page: Page): Locator => page.locator('app-registration-links .link');

/** What belongs to a series, as its chips say it: `RS Synthetic structures`. */
async function belongsTo(page: Page, seriesUid: string): Promise<string[]> {
  return chipOf(page, seriesUid)
    .locator('app-rt-chips li')
    .evaluateAll((chips) =>
      chips.map(
        (chip) =>
          `${chip.querySelector('.rt-code')!.textContent} ${chip.querySelector('.rt-text')!.textContent}`,
      ),
    );
}

/**
 * The synthetic course is on the timeline with everything where it belongs.
 * `target` is what the plan's prescription is said to be to: the structure's
 * name where its structure set was read, its number where it was not (#97).
 */
async function expectCourseOnTimeline(page: Page, target: string): Promise<void> {
  await tileOf(page, COURSE.planningStudy).click();
  const objects = ['RS Synthetic structures', 'RP Synthetic plan', 'RD Synthetic dose'];
  await expect.poll(() => belongsTo(page, COURSE.ct), { timeout: 30_000 }).toEqual(objects);
  // The MR is in the frame the structures are drawn in.
  expect(await belongsTo(page, COURSE.mr)).toEqual(objects);
  // Each says why it is there.
  const [structures, plan, dose] = await chipOf(page, COURSE.ct)
    .locator('app-rt-chips li')
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute('title')));
  expect(structures).toBe('Structure set “Synthetic structures”. It names this series.');
  // The plan says its fractions and its prescription too (#97), and in brief beside its name.
  expect(plan).toBe(
    `Plan “Synthetic plan”. ${FRACTIONS} fractions · ${PRESCRIBED} Gy to “${target}”. It names a structure set that belongs to this series.`,
  );
  for (const series of [COURSE.ct, COURSE.mr]) {
    await expect(chipOf(page, series).locator('app-rt-chips .rt-more')).toHaveText([
      `${FRACTIONS} fx · ${PRESCRIBED} Gy`,
    ]);
    // And whole: the name gives way to it, not it to the name.
    expect(
      await chipOf(page, series)
        .locator('app-rt-chips .rt-more')
        .evaluate((more) => more.scrollWidth <= more.clientWidth),
    ).toBe(true);
  }
  expect(dose).toBe('Dose “Synthetic dose”. It names a plan that belongs to this series.');
  expect(
    await chipOf(page, COURSE.mr).locator('app-rt-chips li').first().getAttribute('title'),
  ).toBe(
    'Structure set “Synthetic structures”. It names the frame of reference this series is in.',
  );
  // The dose is a series of its own, with nothing belonging to it; nothing is left over.
  await expect(page.locator('.series-strip li[data-series-uid]')).toHaveCount(3);
  await expect(page.locator('.series-strip app-rt-chips')).toHaveCount(2);
  await expect(page.locator('.loose')).toHaveCount(0);

  // The registration: one link, by a matrix, between the two CTs it names.
  await expect(link(page)).toHaveCount(1);
  await expect(link(page).locator('.link-end')).toHaveText([PLANNING_CT, FOLLOW_UP_CT]);
  await expect(link(page).locator('.link-kind')).toHaveText('matrix');
}

test('the timeline shows structure sets, plans and doses with their series, and a registration as a link that opens the pair', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await requireWebGpu(page);
  await importFiles(page, syntheticRtCourse(32));
  await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
  // The structure set was opened with the plan, so the target has its name.
  await expectCourseOnTimeline(page, TARGET);

  // Its line is drawn from the planning CT's chip to the follow-up study's
  // tile, which stands for the CT in it while it is closed.
  const line = page.locator('.link-lines path');
  await expect(line).toHaveCount(1);
  await expect(line).not.toHaveClass(/deformable/);
  // The path as it is drawn, without its stroke. Playwright's own box of a
  // stroked path is wider than the path by half the stroke times the miter
  // limit, 3 px here, which is more than the line may be out by.
  const [drawn, from, to] = await Promise.all([
    line.evaluate((path) => {
      const { x, y, width, height } = path.getBoundingClientRect();
      return { x, y, width, height };
    }),
    chipOf(page, COURSE.ct).boundingBox(),
    tileOf(page, COURSE.followUpStudy).boundingBox(),
  ]);
  const middle = (box: { x: number; width: number }): number => box.x + box.width / 2;
  // To the tenth of a pixel the path is written to, and no more.
  expect(Math.abs(drawn.x - middle(from!))).toBeLessThan(0.2);
  expect(Math.abs(drawn.x + drawn.width - middle(to!))).toBeLessThan(0.2);
  // It runs under both: its lowest part is below the chip and the tile.
  expect(drawn.y + drawn.height).toBeGreaterThan(from!.y + from!.height);
  expect(drawn.y + drawn.height).toBeGreaterThan(to!.y + to!.height);

  // Pointing at the link picks out its two ends, and its line.
  await link(page).hover();
  await expect(chipOf(page, COURSE.ct)).toHaveClass(/linked/);
  await expect(tileOf(page, COURSE.followUpStudy)).toHaveClass(/linked/);
  await expect(chipOf(page, COURSE.mr)).not.toHaveClass(/linked/);
  await expect(line).toHaveClass(/active/);

  // Pressing it offers the pair, either way round; taking one opens it.
  await link(page).click();
  const offers = page.locator('app-registration-links .offer button');
  await expect(offers).toHaveText([
    `Open ${PLANNING_CT} with ${FOLLOW_UP_CT} over it`,
    `Open ${FOLLOW_UP_CT} with ${PLANNING_CT} over it`,
  ]);
  await offers.first().click();
  await expect(page.locator('.blend-bar')).toBeVisible({ timeout: 30_000 });
  // The planning CT is the image, and the follow-up CT is over it by the registration.
  await expect(page.locator('.layer-legend')).toContainText('Placed by registration');
  await expect(
    page.locator('.series-strip li[data-series-uid] app-series-chip.loaded'),
  ).toHaveCount(1);
  await expect(page.locator('app-registration-links .offer')).toHaveCount(0);

  // The metadata panel says what the plan of the image on screen says (#97).
  await page.keyboard.press('i');
  const planRows = page.locator('app-metadata-panel [data-info-plan] .info-row');
  await expect(planRows).toHaveText([
    'LabelSynthetic',
    `Fractions${FRACTIONS} fractions`,
    `Prescription${PRESCRIBED} Gy to “${TARGET}”`,
  ]);
  await expect(page.locator('app-metadata-panel [data-info-plan]')).toHaveCount(1);
  expectNoProblems(problems);
});

test('a server’s timeline shows the same, from what its objects refer to', async ({ page }) => {
  const server = await startTestServer([PAGE_ORIGIN]);
  try {
    await server.upload(syntheticRtCourse(32));
    const problems = watchProblems(page);
    await preAcknowledge(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await requireWebGpu(page);
    const card = await connectTo(page, server.address, 'empty state');
    await studyRows(card).filter({ hasText: SYNTHETIC_PATIENT.id }).first().click();
    await expect(page.locator('.study-tile')).toHaveCount(2, { timeout: 30_000 });
    // The server tells of the structure set's file, not of its structures' names.
    await expectCourseOnTimeline(page, `ROI ${TARGET_ROI}`);
    await expect(page.locator('.link-lines path')).toHaveCount(1);
    expectNoProblems(problems);
  } finally {
    await server.stop();
  }
});
