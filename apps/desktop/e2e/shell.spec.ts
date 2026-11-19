/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The shell as it runs (#61): Electron is started on the built application,
// and the page is asked what it can reach. One application for the file;
// the tests run in order and each leaves the page in the application.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_GLOBAL,
  BRIDGE_VERSION,
  isDesktopInfo,
  type DesktopInfo,
} from '@open-rt-studio/desktop-bridge';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { APP_HOME, contentSecurityPolicy } from '../src/policy.js';

import { draws, gpuArgs, gpuEnv, gpuOffer } from './gpu.js';
import { standInKeychainArgs } from './keychain.js';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
/** An address that is nobody's (RFC 2606): nothing is ever sent to it, here or anywhere. */
const ELSEWHERE = 'https://elsewhere.invalid/';

test.describe.configure({ mode: 'serial' });

let profile: string;
let application: ElectronApplication;
let page: Page;
/** What the page logged as an error, and what it threw: a refused load says so here. */
const problems: string[] = [];

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'open-rt-studio-desktop-'));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  application = await electron.launch({
    // The GPU as the run asks for it: the machine's, none, or a software one.
    args: [DESKTOP, ...standInKeychainArgs(), ...gpuArgs()],
    cwd: DESKTOP,
    // A profile of its own: the test finds no acknowledgement and leaves none.
    env: { ...env, ...gpuEnv(), OPEN_RT_STUDIO_DESKTOP_USER_DATA: profile },
  });
  page = await application.firstWindow();
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
});

test.afterAll(async () => {
  await application?.close();
  // Windows may hold the profile a moment longer; it is a temporary folder either way.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
});

test("the viewer runs in the window, from the application's own files", async () => {
  // A first run asks for the notice, as the web client does.
  await expect(page).toHaveURL(`${APP_HOME}disclaimer`);
  await expect(page).toHaveTitle('Open RT Studio');
  await expect(page.getByRole('heading', { name: /not for clinical use/i })).toBeVisible();
  await page.getByRole('button', { name: /i acknowledge and accept/i }).click();

  await expect(page).toHaveURL(APP_HOME);
  await expect(page.locator('header.toolbar')).toBeVisible();
  await expect(page.locator('.brand')).toHaveText('Open RT Studio');
  await expect(page.getByRole('button', { name: /open folder/i })).toBeVisible();
  // The whole style sheet is in force, which a refused script once kept from it.
  expect(await page.evaluate(() => getComputedStyle(document.body).margin)).toBe('0px');

  // A page of the application that is asked for by its address gets the application.
  await page.reload();
  await expect(page).toHaveURL(APP_HOME);
  await expect(page.locator('header.toolbar')).toBeVisible();
  expect(problems).toEqual([]);
});

test('the page has no Node, and runs isolated in a sandbox', async () => {
  const reach = await page.evaluate(() => {
    const names = ['require', 'process', 'module', 'Buffer', 'global', '__dirname', 'electron'];
    const all = globalThis as Record<string, unknown>;
    return names.filter((name) => typeof all[name] !== 'undefined');
  });
  expect(reach).toEqual([]);

  // And what the system says of the page's process, where Electron can tell.
  const sandboxed = await application.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .filter((process) => process.type === 'Tab')
      .map((process) => process.sandboxed),
  );
  expect(sandboxed.length).toBeGreaterThan(0);
  if (process.platform !== 'linux') expect(sandboxed).toEqual(sandboxed.map(() => true));
});

test('the bridge is the declared calls and nothing more', async () => {
  const seen = await page.evaluate(async (name) => {
    const bridge = (globalThis as Record<string, unknown>)[name] as Record<string, unknown>;
    const info = await (bridge['info'] as () => Promise<unknown>)();
    return {
      keys: Object.keys(bridge).sort(),
      files: Object.keys(bridge['files'] as object).sort(),
      server: Object.keys(bridge['server'] as object).sort(),
      library: Object.keys(bridge['library'] as object).sort(),
      version: bridge['version'],
      info,
    };
  }, BRIDGE_GLOBAL);
  expect(seen.keys).toEqual(['files', 'info', 'library', 'server', 'version']);
  expect(seen.library).toEqual([
    'cancel',
    'cancelImport',
    'importFolder',
    'importProgress',
    'request',
  ]);
  expect(seen.server).toEqual(['cancel', 'connect', 'connections', 'forget', 'request']);
  expect(seen.files).toEqual(['forget', 'keep', 'list', 'pickFiles', 'pickFolder', 'read']);
  expect(seen.version).toBe(BRIDGE_VERSION);
  expect(isDesktopInfo(seen.info)).toBe(true);

  const main = await application.evaluate(({ app }) => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  }));
  // Drawing in software is a setting of the run, which the application passes on.
  const softwareGpu = Object.keys(gpuEnv()).length > 0;
  expect(seen.info as DesktopInfo).toEqual({ ...main, softwareGpu });
  expect(main.packaged).toBe(false);
});

test("the page runs no script but the application's, and fetches from nowhere else", async () => {
  const policy = await page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  );
  expect(policy).toBe(contentSecurityPolicy());

  const tried = await page.evaluate(async (elsewhere) => {
    const refused: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      refused.push(event.effectiveDirective),
    );
    // A script written into the page.
    const script = document.createElement('script');
    script.textContent = 'globalThis.__written = true';
    document.head.append(script);
    script.remove();
    // Something from another place.
    const fetched = await fetch(elsewhere).then(
      () => 'answered',
      () => 'refused',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Text made into code. (Asked after a wait: what the test's own tooling evaluates
    // directly is let through, as a developer's console is.)
    let evaluated = 'ran';
    try {
      (0, eval)('1');
    } catch (error) {
      evaluated = (error as Error).name;
    }
    // WebAssembly made of bytes is allowed (#359): the smallest module there is, its header alone.
    let compiled = 'compiled';
    try {
      new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
    } catch (error) {
      compiled = (error as Error).name;
    }
    // What was refused is told a moment later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      written: '__written' in globalThis,
      evaluated,
      compiled,
      fetched,
      refused: [...new Set(refused)].sort(),
    };
  }, ELSEWHERE);
  expect(tried).toEqual({
    written: false,
    evaluated: 'EvalError',
    compiled: 'compiled',
    fetched: 'refused',
    refused: ['connect-src', 'script-src', 'script-src-elem'],
  });
});

test('the page is permitted to read what the user picks, and nothing else', async () => {
  const states = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const name of ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read']) {
      out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
    }
    return out;
  });
  expect(states).toEqual({
    geolocation: 'denied',
    notifications: 'denied',
    camera: 'denied',
    microphone: 'denied',
    'clipboard-read': 'denied',
  });
  // The pickers the viewer opens folders and files with are there.
  expect(
    await page.evaluate(() =>
      ['showDirectoryPicker', 'showOpenFilePicker'].map(
        (name) => typeof (globalThis as Record<string, unknown>)[name],
      ),
    ),
  ).toEqual(['function', 'function']);
});

test('WebGPU is there for the viewer', async () => {
  const gpu = await gpuOffer(page);
  test.info().annotations.push({
    type: 'WebGPU',
    description: `${process.platform}: API ${gpu.api ? 'present' : 'missing'}, adapter ${gpu.adapter ? (gpu.software ? 'software' : 'available') : 'not available'}`,
  });
  console.log(`WebGPU on ${process.platform}: ${JSON.stringify(gpu)}`);
  expect(gpu.api).toBe(true);
  // On Linux a run that asks for a software adapter must get one: that is the
  // switches the application sets (#69) doing their work, on a machine with
  // no graphics card at all.
  if (process.env['E2E_SOFTWARE_GPU'] && process.platform === 'linux') {
    expect(gpu.adapter).toBe(true);
  }

  // With nothing to draw on (a runner with no GPU) the viewer says what is
  // missing, in words for this application on this system: nothing of a
  // browser. On Linux that is also a machine that offers only a software
  // adapter nobody asked for, which the viewer does not take.
  if (!draws(gpu)) {
    const notice = page.locator('.gpu-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      gpu.adapter
        ? 'Only a software graphics adapter was found'
        : 'No graphics adapter is available for WebGPU',
    );
    await expect(notice).not.toContainText(/browser|chrome:\/\/|flags/i);
    await expect(notice.getByRole('button', { name: 'Start the viewer again' })).toBeVisible();
    if (process.platform === 'linux') {
      await expect(notice).toContainText('On Linux, WebGPU runs on Vulkan');
      await expect(notice).toContainText('vulkaninfo --summary');
    } else {
      await expect(notice).not.toContainText('Vulkan');
    }
    return;
  }
  // With one it draws.
  await page.getByRole('button', { name: 'Load the synthetic demo patient' }).click();
  await expect(page.locator('div.status')).toContainText('volume 128 × 128 × 64', {
    timeout: 60_000,
  });
  await expect(page.locator('.study-tile')).toHaveCount(2);

  // And what it draws can be saved: a capture is a download the page makes
  // itself, which the rule against going elsewhere must not take for a
  // navigation. The test answers the save dialog, as a person would.
  const saved = join(profile, 'capture.png');
  await application.evaluate(({ session }, path) => {
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path);
      item.once('done', (_done, state) => {
        (globalThis as Record<string, unknown>)['__downloaded'] = state;
      });
    });
  }, saved);
  await page.getByRole('button', { name: /screenshot/i }).click();
  await expect
    .poll(() =>
      application.evaluate(() => (globalThis as Record<string, unknown>)['__downloaded'] ?? null),
    )
    .toBe('completed');
  const capture = await readFile(saved);
  // A PNG, and not an empty one.
  expect([...capture.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(capture.length).toBeGreaterThan(10_000);
  expect(problems.filter((problem) => !problem.includes('Content Security Policy'))).toEqual([]);
});

// The last of the file: after a navigation that was refused, the test's tooling
// waits for it to end before it looks at the page again.
test('the page stays in the application: it goes nowhere else and opens no window', async () => {
  const opened = await page.evaluate((elsewhere) => window.open(elsewhere) === null, ELSEWHERE);
  expect(opened).toBe(true);

  await page.evaluate((elsewhere) => {
    location.href = elsewhere;
  }, ELSEWHERE);
  // Long enough for a navigation to have begun. The page and the main process
  // are asked where they are: the test's tooling saw a navigation asked for
  // and, as it was refused, never saw it end.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => location.href)).toBe(APP_HOME);
  expect(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()),
    ),
  ).toEqual([APP_HOME]);
  expect(await page.evaluate(() => document.querySelector('header.toolbar') !== null)).toBe(true);
  expect(application.windows()).toHaveLength(1);
});
