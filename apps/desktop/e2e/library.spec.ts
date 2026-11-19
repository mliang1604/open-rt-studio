/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The library on this computer (#64), as it runs: the server of this
// repository inside the main process, with nothing listening and no server
// anywhere. A folder is imported, its studies are browsed, a series is
// viewed, a structure is saved, and all of it is there after a restart.
//
// The first tests ask through the bridge, as the page does, and run
// everywhere. The last go through the application's own card and viewer,
// which needs a GPU: they are skipped on a machine without one.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_GLOBAL,
  type DesktopBridge,
  type LibraryImportResult,
} from '@open-rt-studio/desktop-bridge';
import {
  syntheticCtSeries,
  syntheticThoraxPatient,
  SYNTHETIC_STUDY,
  THORAX_PATIENT,
} from '@open-rt-studio/testdata';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { draws, gpuArgs, gpuEnv, gpuOffer } from './gpu.js';
import { standInKeychainArgs } from './keychain.js';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const CT = syntheticCtSeries(6, 24);
const THORAX = syntheticThoraxPatient({ size: 48, slices: 16 });

test.describe.configure({ mode: 'serial' });

let scratch: string;
let profile: string;
let ctFolder: string;
let thoraxFolder: string;
let application: ElectronApplication;
let page: Page;

async function start(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  const args = [DESKTOP, ...standInKeychainArgs(), ...gpuArgs()];
  application = await electron.launch({
    args,
    cwd: DESKTOP,
    env: { ...env, ...gpuEnv(), OPEN_RT_STUDIO_DESKTOP_USER_DATA: profile },
  });
  page = await application.firstWindow();
  await expect(page.locator('app-root')).toBeAttached();
}

/** Have the main process's folder dialog answered as the user would, and count how often it was shown. */
async function answerDialogs(paths: readonly string[]): Promise<void> {
  await application.evaluate(({ dialog }, filePaths) => {
    const shown = globalThis as Record<string, unknown>;
    shown['__dialogs'] = 0;
    dialog.showOpenDialog = async () => {
      shown['__dialogs'] = (shown['__dialogs'] as number) + 1;
      return { canceled: filePaths.length === 0, filePaths: [...filePaths] };
    };
  }, paths);
}
const dialogsShown = (): Promise<number> =>
  application.evaluate(() => (globalThis as Record<string, unknown>)['__dialogs'] as number);

/** Whether the viewer draws here: a GPU, or software that was asked for. */
const hasGpu = async (): Promise<boolean> => draws(await gpuOffer(page));

interface Asked {
  readonly status: number | null;
  readonly failed: string | null;
  readonly said: unknown;
  /** Whether the bytes that crossed the bridge were the answer's own, and no more. */
  readonly exact: boolean;
}

/** Ask the library through the bridge, as the page does. */
async function ask(
  method: string,
  path: string,
  body: Uint8Array | null = null,
  mediaType = 'application/dicom',
): Promise<Asked> {
  return page.evaluate(
    async ([name, how, where, what, type]) => {
      const { library } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const request = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const answer = await library.request({
        request,
        method: how as 'GET',
        path: where,
        headers: what === null ? {} : { 'content-type': type },
        body: what === null ? null : new Uint8Array(what),
      });
      if ('failed' in answer)
        return { status: null, failed: answer.failed, said: null, exact: true };
      let said: unknown;
      try {
        said = JSON.parse(new TextDecoder().decode(answer.body));
      } catch {
        said = answer.body.byteLength;
      }
      return {
        status: answer.status,
        failed: null,
        said,
        exact: answer.body.buffer.byteLength === answer.body.byteLength,
      };
    },
    [BRIDGE_GLOBAL, method, path, body === null ? null : [...body], mediaType] as const,
  );
}

const importFolder = (): Promise<LibraryImportResult> =>
  page.evaluate(
    (name) =>
      ((globalThis as Record<string, unknown>)[name] as DesktopBridge).library.importFolder(),
    BRIDGE_GLOBAL,
  );

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-desktop-library-'));
  profile = join(scratch, 'profile');
  // Generated here, as all test data is: one patient's slices, and another's whole course.
  ctFolder = join(scratch, 'phantom-ct');
  await mkdir(join(ctFolder, 'series-1'), { recursive: true });
  for (const slice of CT) await writeFile(join(ctFolder, 'series-1', slice.name), slice.bytes);
  await writeFile(join(ctFolder, 'notes.txt'), 'not DICOM');
  thoraxFolder = join(scratch, 'thorax');
  await mkdir(thoraxFolder, { recursive: true });
  for (const file of THORAX) await writeFile(join(thoraxFolder, file.name), file.bytes);
});

test.afterAll(async () => {
  await application?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
});

test('the library answers from inside the application, with nothing asked of a network', async () => {
  await start();
  const counts = await ask('GET', '/api/v1/counts');
  expect(counts).toMatchObject({
    status: 200,
    said: { patients: 0, studies: 0, series: 0, instances: 0 },
    exact: true,
  });
  // Nobody to log in as.
  expect((await ask('GET', '/api/v1/session')).status).toBe(200);
  // Its DICOM listener is off unless it is turned on.
  expect(await ask('GET', '/api/v1/dicom')).toMatchObject({
    status: 200,
    said: { listening: null },
  });

  // Only the API, as of a server; and the page itself still fetches from nowhere.
  const outside = await page.evaluate(async (name) => {
    const { library } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
    const tried = (path: string) =>
      library
        .request({
          request: 'Zm9sZGVyLW9mLXRlc3RzIQ',
          method: 'GET',
          path,
          headers: {},
          body: null,
        })
        .then(
          () => 'answered',
          () => 'refused',
        );
    return {
      health: await tried('/health'),
      up: await tried('/api/v1/../../health'),
      direct: await fetch('http://library.invalid/api/v1/counts').then(
        () => 'answered',
        () => 'refused',
      ),
    };
  }, BRIDGE_GLOBAL);
  expect(outside).toEqual({ health: 'refused', up: 'refused', direct: 'refused' });
});

test('through the bridge: a folder the user chooses is imported, and the page is not told where it was', async () => {
  // Dismissed: nothing is imported.
  await answerDialogs([]);
  expect(await importFolder()).toEqual({ not: 'chosen' });

  await answerDialogs([ctFolder]);
  const result = await importFolder();
  expect(result).toEqual({
    imported: {
      total: CT.length + 1,
      stored: CT.length,
      unchanged: 0,
      replaced: 0,
      refused: 1,
      failed: 0,
      cancelled: false,
    },
  });
  expect(await dialogsShown()).toBe(1);
  expect(JSON.stringify(result)).not.toContain('phantom-ct');
  // No import is under way any more.
  expect(
    await page.evaluate(
      (name) =>
        ((globalThis as Record<string, unknown>)[name] as DesktopBridge).library.importProgress(),
      BRIDGE_GLOBAL,
    ),
  ).toBeNull();

  // Browse: the patient, the study, the series and its files.
  const patients = (await ask('GET', '/api/v1/patients')).said as {
    items: { patientId: string }[];
  };
  expect(patients.items.map((one) => one.patientId)).toEqual([SYNTHETIC_STUDY.patient.id]);
  const studies = (await ask('GET', '/api/v1/studies')).said as {
    items: { studyInstanceUid: string }[];
  };
  const series = (await ask('GET', `/api/v1/studies/${studies.items[0].studyInstanceUid}/series`))
    .said as { items: { seriesInstanceUid: string }[] };
  const instances = (
    await ask('GET', `/api/v1/series/${series.items[0].seriesInstanceUid}/instances`)
  ).said as { items: { sopInstanceUid: string }[] };
  expect(instances.items).toHaveLength(CT.length);
  // A file comes back whole, in bytes of its own.
  const file = await ask('GET', `/api/v1/instances/${instances.items[0].sopInstanceUid}/file`);
  expect(file).toMatchObject({ status: 200, said: CT[0].bytes.byteLength, exact: true });

  // The same folder again: everything is there already.
  expect(await importFolder()).toMatchObject({
    imported: { stored: 0, unchanged: CT.length, refused: 1 },
  });
});

test('through the bridge: what the page saves is kept, and all of it is there after a restart', async () => {
  // Save, as the viewer does: an object is sent to the library's API.
  const [first] = THORAX;
  expect((await ask('POST', '/api/v1/instances', first.bytes)).status).toBe(201);
  const before = (await ask('GET', '/api/v1/counts')).said as { instances: number };
  expect(before.instances).toBe(CT.length + 1);

  await application.close();
  // In the profile, and nowhere else.
  expect(await readdir(join(profile, 'library'))).toEqual(
    expect.arrayContaining(['index.sqlite', 'store']),
  );

  await start();
  expect((await ask('GET', '/api/v1/counts')).said).toEqual(before);
  const patients = (await ask('GET', '/api/v1/patients')).said as {
    items: { patientId: string }[];
  };
  expect(patients.items.map((one) => one.patientId).sort()).toEqual(
    [SYNTHETIC_STUDY.patient.id, THORAX_PATIENT.id].sort(),
  );
});

test('in the application: import a folder, browse the library, view a series and save a structure', async () => {
  await page.getByRole('button', { name: /i acknowledge and accept/i }).click();
  await expect(page.locator('header.toolbar')).toBeVisible();
  test.skip(!(await hasGpu()), 'The viewer needs a GPU to show a series: none on this machine.');

  const card = page.locator('app-server-panel');
  await page
    .locator('app-empty-state')
    .getByRole('button', { name: /library/i })
    .click();
  await card.getByRole('button', { name: 'Open the library on this computer' }).click();
  await expect(card.locator('.server-state')).toContainText('Library on this computer');
  // What was imported before is listed.
  await expect(card.locator('.browser-study')).toHaveCount(2);

  await answerDialogs([thoraxFolder]);
  await card.getByRole('button', { name: 'Import a folder…' }).click();
  await expect(card.locator('.server-import')).toContainText(
    `Imported: ${THORAX.length - 1} files added, 1 already there, of ${THORAX.length} files.`,
  );
  const study = card.locator('.browser-study', { hasText: THORAX_PATIENT.id }).first();
  await expect(study).toBeVisible();
  await study.click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.history-patient')).toContainText(THORAX_PATIENT.name);
  await expect(page.locator('app-history-panel')).toContainText('Library on this computer');

  // View.
  await page.locator('.study-tile').first().click();
  const chip = page.locator('app-series-chip').filter({ hasText: 'CT' }).first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16', {
    timeout: 60_000,
  });
  const onChip = page.locator('app-series-chip.loaded .chip-sets');
  await expect(onChip).toHaveAttribute('title', '1 structure set');

  // Save: a new structure, painted with one stamp, goes to the library.
  const save = page.getByRole('button', { name: /save to library/i });
  await expect(save).toBeDisabled();
  await page.getByTitle('Create a new structure and paint it').click();
  await page.getByLabel('Brush shape').selectOption({ label: 'Disk (slice)' });
  const pane = (await page.locator('.pane-overlay .pane').first().boundingBox())!;
  await page.mouse.move(pane.x + pane.width * 0.42, pane.y + pane.height * 0.42);
  await expect(page.locator('.probe')).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('.notice')).toContainText('(Library on this computer)');
  await expect(page.locator('.notice')).toContainText(/^\s*Saved “.+”/);
  await expect(onChip).toHaveAttribute('title', '2 structure sets');

  // Click to segment is off here, and says why (#340): its model runs on
  // WebAssembly, which the page's content policy does not let it compile.
  // Whether the policy should is a decision that is not made by a tool.
  await page.locator('[data-labs]').check();
  await page.locator('[data-contour-tool="segment"]').click();
  await expect(page.locator('[data-segment-off]')).toContainText(
    'content policy does not let a page compile',
  );
  await expect(page.locator('[data-segment-files]')).toHaveCount(0);
  await page.locator('[data-contour-tool="segment"]').click();
  await page.locator('[data-labs]').uncheck();
});

test('in the application: after a restart the library holds what was imported and what was saved', async () => {
  test.skip(!(await hasGpu()), 'The viewer needs a GPU to show a series: none on this machine.');
  await application.close();
  await start();
  await answerDialogs([]);
  await expect(page.locator('header.toolbar')).toBeVisible();

  const card = page.locator('app-server-panel');
  await page
    .locator('app-empty-state')
    .getByRole('button', { name: /library/i })
    .click();
  await card.getByRole('button', { name: 'Open the library on this computer' }).click();
  const study = card.locator('.browser-study', { hasText: THORAX_PATIENT.id }).first();
  await expect(study).toBeVisible();
  await study.click();
  // The study that was open before the restart is open again: the application
  // remembers it, and a click on its tile would shut it.
  await expect(page.locator('.study-tile').first()).toHaveAttribute('aria-expanded', 'true');
  const chip = page.locator('app-series-chip').filter({ hasText: 'CT' }).first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  // The structure set that was saved came back with the series.
  await expect(chip.locator('.chip-sets')).toHaveAttribute('title', '2 structure sets');
  await chip.click();
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16', {
    timeout: 60_000,
  });
  // No dialog was needed for any of it.
  expect(await dialogsShown()).toBe(0);
});
