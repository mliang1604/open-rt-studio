/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  POPULATION_PATIENTS,
  populationPatient,
  populationStudies,
  syntheticPopulation,
  syntheticThoraxPatient,
  THORAX_FOLLOW_UP_STUDY,
  THORAX_PATIENT,
  THORAX_PLANNING_STUDY,
} from '@open-rt-studio/testdata';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { pickSeries } from './fixtures/load';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, openServerCard, studyRows } from './fixtures/server-card';

// The study browser (#37) against the real server of this repository, seeded
// with the synthetic population: 26 patients with 35 small studies, and the
// thorax patient with two. What a search finds is the server's to say, so it
// is tested here and not against a stand-in.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
/** As many studies as the browser shows at a time (`STUDIES_PER_PAGE` in the app). */
const PER_PAGE = 20;

/** A study as a row shows it: who, and when. */
interface Row {
  readonly name: string;
  readonly id: string;
  /** `YYYYMMDD`. */
  readonly date: string;
  readonly modalities: readonly string[];
}

/** Every study the server is given, from what the generators say they write. */
const SEEDED: readonly Row[] = [
  ...populationStudies().map(({ study, modality }) => ({
    name: study.patient.name,
    id: study.patient.id,
    date: study.date,
    modalities: [modality],
  })),
  {
    name: THORAX_PATIENT.name,
    id: THORAX_PATIENT.id,
    date: THORAX_PLANNING_STUDY.date,
    modalities: ['CT', 'MR', 'RTDOSE', 'RTSTRUCT'],
  },
  {
    name: THORAX_PATIENT.name,
    id: THORAX_PATIENT.id,
    date: THORAX_FOLLOW_UP_STUDY.date,
    modalities: ['CT'],
  },
];

const newestFirst = (rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => b.date.localeCompare(a.date));
const oldestFirst = (rows: readonly Row[]): Row[] => newestFirst(rows).reverse();
/** By name; a patient's own studies the latest first. */
const byPatient = (rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name) || b.date.localeCompare(a.date));

const dateLabel = (date: string): string =>
  `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
/** What the rows of the card should read for these studies, in this order. */
const shownAs = (rows: readonly Row[]): string[] =>
  rows.map((row) => `${row.name} ${row.id} ${dateLabel(row.date)}`);

/** What the rows of the card read now. */
async function shown(card: Locator): Promise<string[]> {
  return studyRows(card).evaluateAll((rows) =>
    rows.map((row) =>
      ['.study-patient', '.study-id', '.study-date']
        .map((selector) => row.querySelector(selector)?.textContent.trim() ?? '')
        .join(' '),
    ),
  );
}

/** Wait until the card lists exactly these studies, in this order. */
async function expectListed(card: Locator, rows: readonly Row[]): Promise<void> {
  await expect.poll(() => shown(card), { timeout: 15_000 }).toEqual(shownAs(rows));
}

const search = (card: Locator): Promise<void> =>
  card.getByRole('button', { name: 'Search', exact: true }).click();
const clear = (card: Locator): Promise<void> =>
  card.getByRole('button', { name: 'Clear', exact: true }).click();

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([PAGE_ORIGIN]);
  await server.upload([
    ...syntheticPopulation(),
    ...syntheticThoraxPatient({ size: 48, slices: 16 }),
  ]);
});
test.afterAll(async () => {
  await server.stop();
});

async function open(page: Page): Promise<void> {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
}

// The issue's first "done when".
test('patients ingested on a test server appear in the browser, a part at a time', async ({
  page,
}) => {
  await open(page);
  const card = await connectTo(page, server.address);
  const all = newestFirst(SEEDED);
  expect(all.length).toBeGreaterThan(PER_PAGE);
  expect(all.length).toBeLessThanOrEqual(2 * PER_PAGE);

  await expectListed(card, all.slice(0, PER_PAGE));
  const previous = card.getByRole('button', { name: 'Previous' });
  const next = card.getByRole('button', { name: 'Next' });
  await expect(previous).toBeDisabled();
  const names = new Set((await shown(card)).map((row) => row.split(' ')[0]));

  await next.click();
  await expectListed(card, all.slice(PER_PAGE));
  await expect(card.locator('.browser-pager')).toContainText('Page 2');
  await expect(next).toBeDisabled();
  for (const row of await shown(card)) names.add(row.split(' ')[0]);
  // Every patient that was ingested has been listed.
  expect(names).toEqual(new Set(SEEDED.map((row) => row.name)));
  expect(names.size).toBe(POPULATION_PATIENTS + 1);

  await previous.click();
  await expectListed(card, all.slice(0, PER_PAGE));
});

// The issue's second "done when".
test('search, order and paging work against the seeded server', async ({ page }) => {
  await open(page);
  const card = await connectTo(page, server.address);
  const name = card.getByLabel('Patient name');
  const id = card.getByLabel('Patient ID');

  // By part of a name, without regard to case.
  const hawthorn = populationPatient(10);
  expect(hawthorn.name).toBe('HAWTHORN^SYNTHETIC');
  await name.fill('hawth');
  // Typing asks nothing: the list is still everything.
  await expectListed(card, newestFirst(SEEDED).slice(0, PER_PAGE));
  await search(card);
  await expectListed(card, newestFirst(SEEDED.filter((row) => row.name === hawthorn.name)));
  // Enter in a field searches too.
  await name.fill('thorax');
  await name.press('Enter');
  await expectListed(card, newestFirst(SEEDED.filter((row) => row.id === THORAX_PATIENT.id)));

  // By Patient ID: whole, or as a pattern.
  await clear(card);
  await expect(name).toHaveValue('');
  await id.fill('SYN-1004');
  await search(card);
  await expectListed(card, newestFirst(SEEDED.filter((row) => row.id === 'SYN-1004')));
  await id.fill('SYN-100');
  await search(card);
  await expect(card.locator('.browser-note')).toHaveText('No study matches.');
  await id.fill('SYN-100*');
  await search(card);
  await expectListed(card, newestFirst(SEEDED.filter((row) => row.id.startsWith('SYN-100'))));

  // By study date: a range, and a range open at one end.
  await clear(card);
  await card.getByLabel('From').fill('2026-01-10');
  await card.getByLabel('To').fill('2026-01-15');
  await search(card);
  await expectListed(
    card,
    newestFirst(SEEDED.filter((row) => row.date >= '20260110' && row.date <= '20260115')),
  );
  await card.getByLabel('To').fill('');
  await card.getByLabel('From').fill('2026-03-10');
  await search(card);
  await expectListed(card, newestFirst(SEEDED.filter((row) => row.date >= '20260310')));

  // By modality, and with a date: joined by "and".
  await clear(card);
  await card.getByLabel('Modality').selectOption('MR');
  await search(card);
  const withMr = SEEDED.filter((row) => row.modalities.includes('MR'));
  await expectListed(card, newestFirst(withMr));
  await card.getByLabel('From').fill('2026-03-01');
  await search(card);
  await expectListed(card, newestFirst(withMr.filter((row) => row.date >= '20260301')));

  // Another order asks again, of the same search.
  await card.getByLabel('Order').selectOption({ label: 'Oldest first' });
  await expectListed(card, oldestFirst(withMr.filter((row) => row.date >= '20260301')));

  // Cleared, the order stays, and everything is listed in it, a part at a time.
  await clear(card);
  await expectListed(card, oldestFirst(SEEDED).slice(0, PER_PAGE));
  await card.getByLabel('Order').selectOption({ label: 'By patient name' });
  await expectListed(card, byPatient(SEEDED).slice(0, PER_PAGE));
  await card.getByRole('button', { name: 'Next' }).click();
  await expectListed(card, byPatient(SEEDED).slice(PER_PAGE));

  // A search is narrowed from its first part, not from the part that was showing.
  await name.fill('yew');
  await search(card);
  await expectListed(card, byPatient(SEEDED.filter((row) => row.name.startsWith('YEW'))));
  await expect(card.locator('.browser-pager')).toContainText('Page 1');

  // Nothing that was typed is kept in the browser.
  const kept = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  for (const typed of ['hawth', 'thorax', 'SYN-100', 'yew']) expect(kept).not.toContain(typed);
  expect(kept).not.toContain('SYNTHETIC');
});

// "Selecting a patient opens their timeline."
test('choosing a study opens the timeline of its patient', async ({ page }) => {
  await open(page);
  const card = await connectTo(page, server.address);
  await card.getByLabel('Patient name').fill('thorax');
  await search(card);
  const thorax = newestFirst(SEEDED.filter((row) => row.id === THORAX_PATIENT.id));
  await expectListed(card, thorax);

  // Either of the patient's studies leads to the patient.
  await studyRows(card).last().click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.history-patient')).toContainText(THORAX_PATIENT.name);
  await expect(page.locator('.study-tile')).toHaveCount(thorax.length);
  await pickSeries(page, 'CT');
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16');

  // Opened again, the browser marks that patient's studies.
  await openServerCard(page, 'history');
  await expectListed(card, newestFirst(SEEDED).slice(0, PER_PAGE));
  const marked = studyRows(card).and(card.locator('[aria-current="true"]'));
  await expect(marked).toHaveCount(
    newestFirst(SEEDED)
      .slice(0, PER_PAGE)
      .filter((row) => row.id === THORAX_PATIENT.id).length,
  );

  // Another patient: the viewport is emptied, and the timeline is theirs.
  const willow = populationPatient(24);
  await studyRows(card).filter({ hasText: willow.id }).first().click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.history-patient')).toContainText(willow.name);
  await expect(page.locator('.study-tile')).toHaveCount(
    SEEDED.filter((row) => row.id === willow.id).length,
  );
  await expect(page.locator('div.status')).not.toContainText('volume');
});
