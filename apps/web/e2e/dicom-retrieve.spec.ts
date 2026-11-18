/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readInstanceHeader } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  SYNTHETIC_STUDY,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { expectNoProblems, preAcknowledge, requireWebGpu, watchProblems } from './fixtures/app';
import { serverApi, storedDataSet } from './fixtures/dicom-peers';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, openServerCard, studyRows } from './fixtures/server-card';

// Finding and retrieving from another system (#54), between two real
// servers and from the page alone: the one the viewer is connected to holds
// nothing and listens for DICOM; the other, the archive, holds a synthetic
// course and knows the first as a place to send to. A study is found on the
// archive and retrieved, and is then among the server's studies and in the
// timeline; a second study of the patient arrives while the timeline shows
// them, and is added to it. What arrives is compared with what the archive
// holds, byte for byte.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;
const COURSE = syntheticRtCourse();

let ours: TestServer;
let archive: TestServer;
/** The id our server knows the archive by, and where the archive listens. */
let known: { id: string; port: number };

const ARCHIVE = { name: 'Archive', aeTitle: 'ARCHIVE', host: '127.0.0.1', mayRetrieve: false };

test.beforeAll(async () => {
  ours = await startTestServer([PAGE_ORIGIN]);
  archive = await startTestServer();
  await archive.upload(COURSE);
  type Listening = { listening: { port: number } };
  const here = await serverApi<Listening>(ours, 'PUT', '/dicom/local', {
    enabled: true,
    port: 0,
    aeTitle: 'OURS',
  });
  const there = await serverApi<Listening>(archive, 'PUT', '/dicom/local', {
    enabled: true,
    port: 0,
    aeTitle: 'ARCHIVE',
  });
  // The archive answers our server, and knows where to send what it asks for.
  await serverApi(archive, 'POST', '/dicom/remotes', {
    name: 'The viewer’s server',
    aeTitle: 'OURS',
    host: '127.0.0.1',
    port: here.listening.port,
    mayStore: false,
    mayRetrieve: true,
  });
  // Our server knows the archive, and at first does not let it send objects here.
  const added = await serverApi<{ id: string }>(ours, 'POST', '/dicom/remotes', {
    ...ARCHIVE,
    port: there.listening.port,
    mayStore: false,
  });
  known = { id: added.id, port: there.listening.port };
});
test.afterAll(async () => {
  await ours.stop();
  await archive.stop();
});

const panel = (page: Page) => page.locator('app-server-panel app-retrieve-panel');
/** The studies found, as the table reads, without the button. */
const found = (page: Page) =>
  panel(page)
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('th, td:not(.retrieve-actions)')].map((cell) =>
          cell.textContent.trim().replace(/\s+/g, ' '),
        ),
      ),
    );
/** The retrieves as the panel reads: what and where from, then what became of it. */
const retrieves = (page: Page) =>
  panel(page)
    .locator('.retrieve-list li:not(.retrieve-note)')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.querySelector('.retrieve-what')!.textContent.trim().replace(/\s+/g, ' '),
        row.querySelector('.retrieve-said')!.textContent.trim(),
      ]),
    );
const held = async (server: TestServer): Promise<number> =>
  (await serverApi<{ instances: number }>(server, 'GET', '/counts')).instances;
/** The SOP Instance UIDs of the course's files that are of a study. */
const instancesOf = (studyUid: string): string[] =>
  COURSE.flatMap((file) => {
    const read = readInstanceHeader(file.bytes);
    return read.ok && read.header.study.uid === studyUid ? [read.header.sopInstanceUid] : [];
  });

const PLANNING = `${SYNTHETIC_PATIENT.name}, 2026-01-05`;
const FOLLOW_UP = `${SYNTHETIC_PATIENT.name}, 2026-03-16`;

test('a study is found on another system, retrieved, and is then on the server and in the timeline', async ({
  page,
}) => {
  const problems = watchProblems(page);
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  const card = await connectTo(page, ours.address);
  // The server holds nothing.
  await expect(studyRows(card)).toHaveCount(0);
  await card.getByRole('button', { name: 'Retrieve…' }).click();
  await expect(panel(page).getByLabel('System', { exact: true })).toHaveValue(known.id);
  await expect(panel(page).locator('#retrieve-source option')).toHaveText(['Archive (ARCHIVE)']);
  await expect(panel(page)).toContainText('Nothing was retrieved since the server started.');

  // The archive may not send objects here yet: it can be asked, and nothing can be retrieved.
  await expect(panel(page).locator('#retrieve-cannot')).toContainText(
    'Archive can be asked what it holds, but nothing it sent would arrive',
  );
  await panel(page).getByLabel('Patient name').fill('SYNTH*');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => found(page))
    .toEqual([
      [
        ...[SYNTHETIC_PATIENT.name, SYNTHETIC_PATIENT.id, '2026-03-16'],
        ...[SYNTHETIC_FOLLOW_UP_STUDY.description, 'CT REG', '3 instances'],
      ],
      [
        ...[SYNTHETIC_PATIENT.name, SYNTHETIC_PATIENT.id, '2026-01-05'],
        ...[SYNTHETIC_STUDY.description, 'CT MR RTDOSE RTPLAN RTSTRUCT', '8 instances'],
      ],
    ]);
  await expect(
    panel(page).getByRole('button', { name: `Retrieve the study of ${PLANNING}` }),
  ).toBeDisabled();

  // An administrator lets it; the panel, opened anew, offers the retrieve.
  await serverApi(ours, 'PUT', `/dicom/remotes/${known.id}`, {
    ...ARCHIVE,
    port: known.port,
    mayStore: true,
  });
  await card.getByRole('button', { name: 'Studies' }).click();
  await card.getByRole('button', { name: 'Retrieve…' }).click();
  await expect(panel(page).getByLabel('System', { exact: true })).toHaveValue(known.id);
  await expect(panel(page).locator('#retrieve-cannot')).toHaveCount(0);

  // Asked more narrowly: by ID, the days and what it has; and for what is not there.
  await panel(page).getByLabel('Patient ID').fill('NOBODY*');
  await panel(page).getByRole('button', { name: 'Search' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('No study matches.');
  await panel(page).getByLabel('Patient ID').fill(SYNTHETIC_PATIENT.id);
  await panel(page).locator('#retrieve-from').fill('2026-01-01');
  await panel(page).locator('#retrieve-to').fill('2026-01-31');
  await panel(page).getByLabel('Modality').selectOption('RTDOSE');
  await panel(page).getByRole('button', { name: 'Search' }).click();
  await expect.poll(async () => (await found(page)).map((row) => row[2])).toEqual(['2026-01-05']);

  // Retrieved: the archive sends to our server's listener, and the panel says what arrived.
  expect(await held(ours)).toBe(0);
  await panel(page)
    .getByRole('button', { name: `Retrieve the study of ${PLANNING}` })
    .click();
  await expect
    .poll(() => retrieves(page))
    .toEqual([[`${PLANNING} from Archive`, 'Retrieved: 8 instances.']]);
  expect(await held(ours)).toBe(8);
  // What arrived is what the archive holds, byte for byte.
  const uids = instancesOf(SYNTHETIC_RT_COURSE.planningStudy);
  expect(uids).toHaveLength(8);
  for (const uid of uids) {
    expect((await storedDataSet(ours, uid)).equals(await storedDataSet(archive, uid)), uid).toBe(
      true,
    );
  }

  // It is among the server's studies,
  await card.getByRole('button', { name: 'Studies' }).click();
  await expect(studyRows(card)).toHaveCount(1);
  await expect(studyRows(card).first()).toContainText(SYNTHETIC_PATIENT.name);
  // and its patient is opened from the retrieve: the timeline has the study.
  await card.getByRole('button', { name: 'Retrieve…' }).click();
  await panel(page)
    .getByRole('button', { name: `Open the timeline of ${PLANNING}` })
    .click();
  const history = page.locator('app-history-panel');
  await expect(history).toBeVisible();
  await expect(history.locator('.study-tile')).toHaveCount(1);
  await expect(history.locator('.study-desc')).toHaveText([SYNTHETIC_STUDY.description]);
  await expect(history.locator('.modality-badge')).toHaveText(['CT', 'MR', 'RTDOSE']);

  // More of the patient arrives while the timeline shows them: it is added to it.
  await openServerCard(page, 'history');
  await card.getByRole('button', { name: 'Retrieve…' }).click();
  // The retrieve made before is the server's: it is there for a panel opened anew.
  await expect.poll(async () => (await retrieves(page)).length).toBe(1);
  await panel(page).getByLabel('Patient name').fill('SYNTH*');
  await panel(page).getByRole('button', { name: 'Search' }).click();
  await panel(page)
    .getByRole('button', { name: `Retrieve the study of ${FOLLOW_UP}` })
    .click();
  await expect
    .poll(async () => (await retrieves(page))[0])
    .toEqual([`${FOLLOW_UP} from Archive`, 'Retrieved: 3 instances.']);
  expect(await held(ours)).toBe(11);
  await expect(history.locator('.study-tile')).toHaveCount(2);
  await expect(history.locator('.study-desc')).toHaveText([
    SYNTHETIC_STUDY.description,
    SYNTHETIC_FOLLOW_UP_STUDY.description,
  ]);
  expectNoProblems(problems);
});
