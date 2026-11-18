/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Folders through the bridge (#62), in the application as it runs: a folder
// is opened with the system's dialog, the application is closed and started
// again, and the folder opens from the Recent list without a dialog.
//
// A test cannot answer the system's dialog, so the main process's is
// replaced by one that answers as the user would, with a folder of synthetic
// slices. Everything after the dialog is what runs for a person.

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRIDGE_GLOBAL, type DesktopBridge } from '@open-rt-studio/desktop-bridge';
import { syntheticCtSeries } from '@open-rt-studio/testdata';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = 'phantom-ct';
const SLICES = 12;

test.describe.configure({ mode: 'serial' });

let scratch: string;
let profile: string;
/** The folder the user chooses, and something beside it that they did not. */
let folder: string;
let application: ElectronApplication;
let page: Page;

async function start(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  application = await electron.launch({
    args: [DESKTOP],
    cwd: DESKTOP,
    env: { ...env, OPEN_RT_STUDIO_DESKTOP_USER_DATA: profile },
  });
  page = await application.firstWindow();
}

/** Have the system's dialog answer with `paths`, and count how often it is shown. */
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

const studies = () => page.locator('.study-tile');
const recent = () => page.locator('label.ctrl', { hasText: 'Recent' });

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-desktop-files-'));
  profile = join(scratch, 'profile');
  folder = join(scratch, FOLDER);
  // Generated here, as all test data is: slices in a folder inside the one that is chosen.
  await mkdir(join(folder, 'series-1'), { recursive: true });
  for (const slice of syntheticCtSeries(SLICES, 32)) {
    await writeFile(join(folder, 'series-1', slice.name), slice.bytes);
  }
  await writeFile(join(scratch, 'not-chosen.txt'), 'beside the folder');
});

test.afterAll(async () => {
  await application?.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
});

test('a folder is opened with the system dialog, and read through the bridge', async () => {
  await start();
  await page.getByRole('button', { name: /i acknowledge and accept/i }).click();
  await expect(page.locator('header.toolbar')).toBeVisible();

  // Dismissed: nothing happens, and nothing else opens in its place.
  await answerDialogs([]);
  await page.getByRole('button', { name: /open folder/i }).click();
  await expect.poll(dialogsShown).toBe(1);
  await expect(studies()).toHaveCount(0);

  await answerDialogs([folder]);
  await page.getByRole('button', { name: /open folder/i }).click();
  await expect(studies()).toHaveCount(1, { timeout: 30_000 });
  expect(await dialogsShown()).toBe(1);
  await expect(studies()).toContainText('1 series');
  // It is in the Recent list, as one that opens again without being picked.
  await expect(recent().locator('option').nth(1)).toHaveText(FOLDER);
});

test('the page reads what was chosen and nothing beside it', async () => {
  const tried = await page.evaluate(async (name) => {
    const { files } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
    // The grant the Recent list kept: its id is all the page has of the folder.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('open-rt-studio');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const kept = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const request = database.transaction('recent-handles').objectStore('recent-handles').getAll();
      request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
      request.onerror = () => reject(request.error);
    });
    const id = kept[0]['desktopGrant'] as string;
    const listing = (await files.list(id))!;
    const first = listing.files[0];
    const head = await files.read(id, first.path, 128, 4);
    const outcome = (call: Promise<unknown>) =>
      call.then(
        (value) => (value === null ? 'nothing' : 'answered'),
        () => 'refused',
      );
    return {
      kept: kept.map((stored) => Object.keys(stored).sort()),
      paths: listing.files.map((file) => file.path),
      head: head === null ? null : new TextDecoder().decode(head),
      outside: await outcome(files.read(id, '../not-chosen.txt', 0, 10)),
      absolute: await outcome(files.read(id, '/etc/hosts', 0, 10)),
      unknown: await outcome(files.list('Zm9sZGVyLW9mLXRlc3RzIQ')),
      malformed: await outcome(files.list('../../etc')),
      named: await outcome(
        (files.pickFolder as unknown as (path: string) => Promise<unknown>)('/etc'),
      ),
    };
  }, BRIDGE_GLOBAL);
  // What is kept says nothing of where the folder is.
  expect(tried.kept).toEqual([['desktopGrant', 'kind', 'name']]);
  expect(tried.paths).toHaveLength(SLICES);
  expect(tried.paths.every((path) => path.startsWith('series-1/'))).toBe(true);
  // The bytes are the file's: a DICOM file says so at 128.
  expect(tried.head).toBe('DICM');
  expect(tried.outside).toBe('refused');
  expect(tried.absolute).toBe('refused');
  expect(tried.unknown).toBe('nothing');
  expect(tried.malformed).toBe('refused');
  // The preload script passes on no argument of the page's: the dialog is the user's.
  expect(['nothing', 'answered']).toContain(tried.named);
});

test('after a restart the folder opens from the Recent list, without a dialog', async () => {
  await application.close();
  // What the main process kept is the folder's place, for the user alone to read.
  const grants = JSON.parse(await readFile(join(profile, 'file-grants.json'), 'utf8')) as {
    grants: { kind: string; name: string; paths: string[] }[];
  };
  expect(grants.grants).toHaveLength(1);
  expect(grants.grants[0]).toMatchObject({ kind: 'folder', name: FOLDER });

  await start();
  await answerDialogs([]);
  await expect(page.locator('header.toolbar')).toBeVisible();
  await expect(studies()).toHaveCount(0);
  await expect(recent().locator('option').nth(1)).toHaveText(FOLDER);

  await recent().locator('select').selectOption({ index: 1 });
  await expect(studies()).toHaveCount(1, { timeout: 30_000 });
  await expect(studies()).toContainText('1 series');
  expect(await dialogsShown()).toBe(0);
});

test('a folder that was moved is said to be gone, and is picked again', async () => {
  await page.getByRole('button', { name: /close patient/i }).click();
  await expect(studies()).toHaveCount(0);
  await rename(folder, join(scratch, 'moved'));

  await recent().locator('select').selectOption({ index: 1 });
  await expect(page.locator('.notice')).toHaveText(
    `${FOLDER} is no longer where it was. Pick it again.`,
  );
  await expect(studies()).toHaveCount(0);
  await expect(recent().locator('option').nth(1)).toHaveText(`${FOLDER} · pick again`);
  expect(await dialogsShown()).toBe(0);
});

test('files are opened with the system dialog too', async () => {
  const moved = join(scratch, 'moved', 'series-1');
  const [first, second] = syntheticCtSeries(SLICES, 32).map((slice) => join(moved, slice.name));
  await answerDialogs([first, second]);
  await page.getByRole('button', { name: /open files/i }).click();
  await expect(studies()).toHaveCount(1, { timeout: 30_000 });
  expect(await dialogsShown()).toBe(1);
  // Several files are picked again, as in a browser; they are not kept.
  await expect(recent().locator('option').nth(1)).toHaveText('2 files · pick again');
});
