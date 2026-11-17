/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticRtCourse } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge, requireWebGpu } from './fixtures/app';
import { startTestServer, type TestServer } from './fixtures/server';
import { connectTo, openServerCard, studyRows } from './fixtures/server-card';

// Sending to another system (#50), between two real servers: one holds a
// synthetic course and is what the viewer is connected to, the other is the
// destination and listens for DICOM. A series is sent to an address where
// nothing is, which fails for every instance; the address is put right and
// the failures are sent again; then a structure set is sent by itself. What
// arrives is compared with what was sent, byte for byte.

const PAGE_ORIGIN = `http://localhost:${process.env['E2E_PORT'] ?? 4200}`;

let source: TestServer;
let destination: TestServer;
/** The id the source knows the destination by, and where the destination listens. */
let planning: { id: string; port: number };

async function api<T>(
  server: TestServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.address}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** The data set of a stored file: what follows the preamble, `DICM` and the meta group. */
async function dataSet(server: TestServer, sopInstanceUid: string): Promise<Buffer> {
  const response = await fetch(`${server.address}/api/v1/instances/${sopInstanceUid}/file`);
  expect(response.status).toBe(200);
  const file = Buffer.from(await response.arrayBuffer());
  return file.subarray(144 + file.readUInt32LE(140));
}

const PLANNING = { name: 'Planning', aeTitle: 'DEST', host: '127.0.0.1', mayStore: false };

test.beforeAll(async () => {
  source = await startTestServer([PAGE_ORIGIN]);
  destination = await startTestServer();
  await source.upload(syntheticRtCourse());
  // The destination listens, and lets the source in.
  const listening = await api<{ listening: { port: number } }>(destination, 'PUT', '/dicom/local', {
    enabled: true,
    port: 0,
    aeTitle: 'DEST',
  });
  await api(destination, 'POST', '/dicom/remotes', {
    name: 'The source',
    aeTitle: 'SOURCE',
    host: null,
    port: null,
    mayStore: true,
  });
  // The source knows the destination, at first at an address where nothing is.
  await api(source, 'PUT', '/dicom/local', { enabled: false, port: 11112, aeTitle: 'SOURCE' });
  const known = await api<{ id: string }>(source, 'POST', '/dicom/remotes', {
    ...PLANNING,
    port: 9,
  });
  planning = { id: known.id, port: listening.listening.port };
});
test.afterAll(async () => {
  await source.stop();
  await destination.stop();
});

const panel = (page: Page) => page.locator('app-server-panel app-send-panel');
/** The sends as the panel reads: what and where to, then what became of it. */
const sends = (page: Page) =>
  panel(page)
    .locator('.send-list li:not(.send-note)')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.querySelector('.send-what')!.textContent.trim().replace(/\s+/g, ' '),
        row.querySelector('.send-said')!.textContent.trim(),
      ]),
    );
const held = async (server: TestServer): Promise<number> =>
  (await api<{ instances: number }>(server, 'GET', '/counts')).instances;

test('a series and a structure set are sent to another system, and what failed is sent again', async ({
  page,
}) => {
  await preAcknowledge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await requireWebGpu(page);
  const card = await connectTo(page, source.address);
  await card.getByRole('button', { name: 'Send…' }).click();
  // No patient yet: nothing to send.
  await expect(panel(page)).toContainText('Choose a patient among the studies first.');
  await card.getByRole('button', { name: 'Studies' }).click();
  await studyRows(card).first().click();
  // Choosing a patient shuts the card: the timeline is what was asked for.
  await expect(page.locator('app-history-panel')).toBeVisible();
  await openServerCard(page, 'history');
  await card.getByRole('button', { name: 'Send…' }).click();

  await expect(panel(page).getByLabel('Destination')).toHaveValue(planning.id);
  await expect(panel(page).locator('#send-destination option')).toHaveText(['Planning (DEST)']);
  await expect(panel(page)).toContainText('Nothing was sent since the server started.');
  const ct = panel(page).locator('tbody tr').filter({ hasText: 'Synthetic CT ramp' });
  await expect(ct.locator('.send-kind')).toHaveText('CT, 3 images');

  // Nothing is at the address the server has for it: each instance fails, and says why.
  await ct
    .getByRole('button', { name: 'Send Synthetic CT ramp (CT, 3 images) to Planning' })
    .click();
  const nothing = '0 of 3 sent, 3 failed: nothing answered at the system’s address.';
  await expect.poll(() => sends(page)).toEqual([['Synthetic CT ramp to Planning', nothing]]);
  expect(await held(destination)).toBe(0);

  // The address is put right, and what failed is sent again.
  await api(source, 'PUT', `/dicom/remotes/${planning.id}`, { ...PLANNING, port: planning.port });
  await panel(page)
    .getByRole('button', { name: 'Send again what failed of Synthetic CT ramp to Planning' })
    .click();
  await expect
    .poll(() => sends(page))
    .toEqual([
      ['Synthetic CT ramp to Planning, again', '3 of 3 sent.'],
      ['Synthetic CT ramp to Planning', nothing],
    ]);
  expect(await held(destination)).toBe(3);

  // One object by itself: the structure set.
  await panel(page)
    .getByRole('button', { name: 'Send Synthetic structures (Structure set) to Planning' })
    .click();
  await expect
    .poll(async () => (await sends(page))[0])
    .toEqual(['Synthetic structures to Planning', '1 of 1 sent.']);
  expect(await held(destination)).toBe(4);

  // What arrived is what the source holds, byte for byte.
  const arrived = await api<{ items: { instances: { sopInstanceUid: string }[] }[] }>(
    source,
    'GET',
    '/dicom/sends',
  );
  const uids = arrived.items
    .slice(0, 2)
    .flatMap((send) => send.instances.map((one) => one.sopInstanceUid));
  expect(uids).toHaveLength(4);
  for (const uid of uids) {
    expect((await dataSet(destination, uid)).equals(await dataSet(source, uid)), uid).toBe(true);
  }

  // The sends are the server's: they are there for a panel opened anew.
  await card.getByRole('button', { name: 'Studies' }).click();
  await card.getByRole('button', { name: 'Send…' }).click();
  await expect.poll(async () => (await sends(page)).length).toBe(3);
});
