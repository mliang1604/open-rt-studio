/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticCtSeries } from '@open-rt-studio/testdata';
import { expect, test, type Page } from '@playwright/test';

import { preAcknowledge } from './fixtures/app';
import { importFiles } from './fixtures/load';

// Reopening a recent selection from a kept File System Access handle.
//
// A test cannot work the browser's own directory dialog or its permission
// prompt. So the folder is one in the page's private file system (handles to
// it are real handles, and are kept in IndexedDB like any other), the picker
// is replaced by a function that returns it, and the two permission methods
// answer as the test says. What runs for real is everything in between: the
// handle going into IndexedDB, coming back after a reload, and being read.

const FOLDER = 'synthetic-study';

type Permission = 'granted' | 'ask-yes' | 'ask-no';

interface Counters {
  pickerCalls: number;
  permissionRequests: number;
  inputClicks: string[];
}

/** Replace the picker and the permission answers; count what is called. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript((folder) => {
    const counters = { pickerCalls: 0, permissionRequests: 0, inputClicks: [] as string[] };
    Object.assign(window, { e2eCounters: counters });
    const permission = () => localStorage.getItem('e2e-permission') ?? 'granted';
    Object.assign(window, {
      showDirectoryPicker: async () => {
        counters.pickerCalls++;
        return (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      },
    });
    Object.assign(FileSystemHandle.prototype, {
      queryPermission: async () => (permission() === 'granted' ? 'granted' : 'prompt'),
      requestPermission: async () => {
        counters.permissionRequests++;
        return permission() === 'ask-yes' ? 'granted' : 'denied';
      },
    });
    // A file input's click opens a dialog no test can close: note it instead.
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type !== 'file') return click.call(this);
      counters.inputClicks.push(this.hasAttribute('webkitdirectory') ? 'folder' : 'files');
    };
  }, FOLDER);
}

const counters = (page: Page): Promise<Counters> =>
  page.evaluate(() => (window as unknown as { e2eCounters: Counters }).e2eCounters);

/** How the browser treats a kept handle from here on. */
const setPermission = (page: Page, permission: Permission): Promise<void> =>
  page.evaluate((value) => localStorage.setItem('e2e-permission', value), permission);

/** Put a synthetic CT into the folder, in a subfolder, as a study on disk is. */
async function writeFolder(page: Page): Promise<void> {
  const files = syntheticCtSeries(8, 24).map((file) => ({
    name: file.name,
    data: Buffer.from(file.bytes).toString('base64'),
  }));
  await page.evaluate(
    async ([folder, list]) => {
      const root = await navigator.storage.getDirectory();
      const study = await root.getDirectoryHandle(folder as string, { create: true });
      const series = await study.getDirectoryHandle('ct', { create: true });
      for (const { name, data } of list as { name: string; data: string }[]) {
        const writable = await (
          await series.getFileHandle(name, { create: true })
        ).createWritable();
        await writable.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
        await writable.close();
      }
    },
    [FOLDER, files] as const,
  );
}

const recentOptions = (page: Page) =>
  page.locator('label.ctrl', { hasText: 'Recent' }).locator('option');
const chooseRecent = (page: Page) =>
  page.locator('label.ctrl', { hasText: 'Recent' }).locator('select').selectOption({ index: 1 });
const studies = (page: Page) => page.locator('.study-tile');
const notice = (page: Page) => page.locator('.notice');

/** Open the folder with the (replaced) directory picker and wait for its study. */
async function openFolder(page: Page): Promise<void> {
  await preAcknowledge(page);
  await instrument(page);
  await page.goto('/');
  await writeFolder(page);
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await expect(studies(page)).toHaveCount(1);
  // Listed under the folder's name, and not marked for picking again.
  await expect(recentOptions(page).nth(1)).toHaveText(FOLDER);
}

test('a recent folder is reopened after a reload, after one permission prompt', async ({
  page,
}) => {
  await openFolder(page);
  expect((await counters(page)).pickerCalls).toBe(1);

  // A new session: nothing is loaded, and the browser wants to be asked again.
  await setPermission(page, 'ask-yes');
  await page.reload();
  await expect(studies(page)).toHaveCount(0);
  await expect(recentOptions(page).nth(1)).toHaveText(FOLDER);

  await chooseRecent(page);
  await expect(studies(page)).toHaveCount(1);
  await expect(page.locator('div.status')).toHaveText(
    'Pick a series from the history below to view it.',
  );
  // One prompt, and no picker of either kind.
  expect(await counters(page)).toEqual({ pickerCalls: 0, permissionRequests: 1, inputClicks: [] });

  // In the same session access stays given: again, without a prompt.
  await setPermission(page, 'granted');
  await chooseRecent(page);
  await expect(studies(page)).toHaveCount(1);
  expect((await counters(page)).permissionRequests).toBe(1);
});

test('when access is not given nothing is opened, and a notice says so', async ({ page }) => {
  await openFolder(page);
  await setPermission(page, 'ask-no');
  await page.reload();
  await expect(recentOptions(page).nth(1)).toHaveText(FOLDER);

  await chooseRecent(page);
  await expect(notice(page)).toHaveText(`Access to ${FOLDER} was not given, so it was not opened.`);
  await expect(studies(page)).toHaveCount(0);
  expect((await counters(page)).permissionRequests).toBe(1);
  // The entry stays as it was: the user can choose it again and allow it.
  await expect(recentOptions(page).nth(1)).toHaveText(FOLDER);
});

test('a folder that has gone is said to be gone, and is then picked again', async ({ page }) => {
  await openFolder(page);
  await page.evaluate(
    async (folder) =>
      (await navigator.storage.getDirectory()).removeEntry(folder, { recursive: true }),
    FOLDER,
  );
  await page.reload();
  await expect(recentOptions(page).nth(1)).toHaveText(FOLDER);

  await chooseRecent(page);
  await expect(notice(page)).toHaveText(`${FOLDER} is no longer where it was. Pick it again.`);
  await expect(studies(page)).toHaveCount(0);
  await expect(recentOptions(page).nth(1)).toHaveText(`${FOLDER} · pick again`);

  // Now it opens the folder picker, as an entry without a handle does.
  await chooseRecent(page);
  await expect.poll(async () => (await counters(page)).inputClicks).toEqual(['folder']);
});

test('without the File System Access API a recent entry opens the picker, and says so', async ({
  page,
}) => {
  await preAcknowledge(page);
  await instrument(page);
  // After the instrumentation: this browser has no pickers and gives no handles.
  await page.addInitScript(() => {
    Object.assign(window, { showDirectoryPicker: undefined, showOpenFilePicker: undefined });
  });
  await page.goto('/');

  // Open folder and Open files go to the inputs.
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Open files…' }).click();
  expect((await counters(page)).inputClicks).toEqual(['folder', 'files']);

  await importFiles(page, syntheticCtSeries(8, 24));
  await expect(studies(page)).toHaveCount(1);
  await expect(recentOptions(page).nth(1)).toHaveText('8 files · pick again');

  await page.reload();
  await expect(recentOptions(page).nth(1)).toHaveText('8 files · pick again');
  await chooseRecent(page);
  await expect.poll(async () => (await counters(page)).inputClicks).toEqual(['files']);
  await expect(studies(page)).toHaveCount(0);
});

test('a set of several files is picked again even where handles exist', async ({ page }) => {
  await preAcknowledge(page);
  await instrument(page);
  await page.goto('/');
  await importFiles(page, syntheticCtSeries(8, 24));
  await expect(studies(page)).toHaveCount(1);
  await expect(recentOptions(page).nth(1)).toHaveText('8 files · pick again');
});

test('a picker the browser will not show gives way to the file input', async ({ page }) => {
  await preAcknowledge(page);
  await instrument(page);
  await page.addInitScript(() => {
    const refuse = () => Promise.reject(new DOMException('not allowed here', 'SecurityError'));
    Object.assign(window, { showDirectoryPicker: refuse, showOpenFilePicker: refuse });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await expect.poll(async () => (await counters(page)).inputClicks).toEqual(['folder']);
  await page.getByRole('button', { name: 'Open files…' }).click();
  await expect.poll(async () => (await counters(page)).inputClicks).toEqual(['folder', 'files']);

  // A dialog the user closes is not a failure: nothing else opens.
  await page.evaluate(() => {
    const dismissed = () => Promise.reject(new DOMException('dismissed', 'AbortError'));
    Object.assign(window, { showDirectoryPicker: dismissed, showOpenFilePicker: dismissed });
  });
  await page.getByRole('button', { name: 'Open folder…' }).click();
  await page.getByRole('button', { name: 'Open files…' }).click();
  await page.waitForTimeout(200);
  expect((await counters(page)).inputClicks).toEqual(['folder', 'files']);
});
