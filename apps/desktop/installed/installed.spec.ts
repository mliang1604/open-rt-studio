/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The application as an installer leaves it (#65): the program that was
// installed is started, not the repository's build, and asked the few things
// that only a packaged application can get wrong: that its own files are
// found, that it knows it is installed, and that the library in it works,
// which needs every module of the server to have been packed.
//
//   OPEN_RT_STUDIO_INSTALLED          the installed program
//   OPEN_RT_STUDIO_INSTALLED_VERSION  the version it should say it is

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRIDGE_GLOBAL, isDesktopInfo, type DesktopBridge } from '@open-rt-studio/desktop-bridge';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { APP_HOME } from '../src/policy.js';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED = process.env['OPEN_RT_STUDIO_INSTALLED'] ?? '';
const VERSION = process.env['OPEN_RT_STUDIO_INSTALLED_VERSION'] ?? '';

test.describe.configure({ mode: 'serial' });

let profile: string;
let application: ElectronApplication;
let page: Page;
const problems: string[] = [];

test.beforeAll(async () => {
  expect(INSTALLED, 'OPEN_RT_STUDIO_INSTALLED names the installed program').not.toBe('');
  // By its real name: on macOS the temporary folder is reached through a link.
  profile = await realpath(await mkdtemp(join(tmpdir(), 'open-rt-studio-installed-')));
  // An installed application reads no setting of ours from the environment,
  // so its profile is named the way Chromium takes it: the test finds no
  // acknowledgement and no library, and leaves the user's own alone.
  const args = [`--user-data-dir=${profile}`];
  // A stand-in for the keychain, so that the test writes nothing into the
  // user's. On macOS it is more than tidiness: an entry made by one build is
  // not another build's to read while neither is signed by anyone, and the
  // system asks, in a dialog no test can answer.
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (process.platform === 'linux') args.push('--password-store=basic');
  application = await electron.launch({ executablePath: INSTALLED, args });
  page = await application.firstWindow();
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
});

test.afterAll(async () => {
  await application?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
});

test('it starts on its own files, with the notice first', async () => {
  await expect(page).toHaveURL(`${APP_HOME}disclaimer`);
  await expect(page).toHaveTitle('Open RT Studio');
  await expect(page.getByRole('heading', { name: /not for clinical use/i })).toBeVisible();
  await page.getByRole('button', { name: /i acknowledge and accept/i }).click();

  await expect(page).toHaveURL(APP_HOME);
  await expect(page.locator('header.toolbar')).toBeVisible();
  await expect(page.getByRole('button', { name: /open folder/i })).toBeVisible();
  expect(problems).toEqual([]);
});

test('it knows it is installed, which version it is, and keeps its profile where it was told', async () => {
  const info = await page.evaluate(
    (name) => ((globalThis as Record<string, unknown>)[name] as DesktopBridge).info(),
    BRIDGE_GLOBAL,
  );
  expect(isDesktopInfo(info)).toBe(true);
  expect(info.packaged).toBe(true);
  if (VERSION !== '') expect(info.appVersion).toBe(VERSION);

  // The Electron that was packed is the one the repository pins.
  const pinned = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  expect(info.electron).toBe(pinned.devDependencies['electron']);

  const where = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
  }));
  expect(where.packaged).toBe(true);
  expect(await realpath(where.userData)).toBe(profile);
});

test('the library in it answers: the server and all it needs were packed', async () => {
  const counts = await page.evaluate(async (name) => {
    const { library } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
    // A request goes by 16 random bytes, written as the bridge wants them.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const request = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const answer = await library.request({
      request,
      method: 'GET',
      path: '/api/v1/counts',
      headers: {},
      body: null,
    });
    if ('failed' in answer) return { failed: answer.failed };
    return {
      status: answer.status,
      said: JSON.parse(new TextDecoder().decode(answer.body)) as unknown,
    };
  }, BRIDGE_GLOBAL);
  expect(counts).toEqual({
    status: 200,
    said: { patients: 0, studies: 0, series: 0, instances: 0 },
  });
  expect(problems).toEqual([]);
});
