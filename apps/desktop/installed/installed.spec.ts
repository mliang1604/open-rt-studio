/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The application as an installer leaves it (#65): the program that was
// installed is started, not the repository's build, and asked the few things
// that only a packaged application can get wrong: that its own files are
// found, that it knows it is installed, and that the library in it works,
// which needs every module of the server to have been packed. And that it
// registers two series with the native tools that were packed with it (#70):
// no server, no setting, nothing but what the installer left.
//
//   OPEN_RT_STUDIO_INSTALLED          the installed program
//   OPEN_RT_STUDIO_INSTALLED_VERSION  the version it should say it is

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRIDGE_GLOBAL, isDesktopInfo, type DesktopBridge } from '@open-rt-studio/desktop-bridge';
import {
  KNOWN_OFFSET,
  KNOWN_OFFSET_SERIES,
  knownOffsetError,
  knownOffsetPair,
} from '@open-rt-studio/testdata';
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

// ---- The native tools (#70) -------------------------------------------------

/** What the library answered: a status and what it said, or why it did not answer. */
interface Said {
  readonly status: number;
  readonly said: unknown;
}

/**
 * Ask the library in the installed application, through the bridge, as the
 * page does. A body is JSON, or the bytes of a DICOM file in base64.
 */
async function ask(
  method: 'GET' | 'POST',
  path: string,
  body: { json: unknown } | { dicom: string } | null = null,
): Promise<Said> {
  return page.evaluate(
    async ({ name, method, path, body }) => {
      const { library } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
      const random = crypto.getRandomValues(new Uint8Array(16));
      const request = btoa(String.fromCharCode(...random))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const headers: Record<string, string> = {};
      let bytes: Uint8Array | null = null;
      if (body !== null && 'json' in body) {
        headers['content-type'] = 'application/json';
        bytes = new TextEncoder().encode(JSON.stringify(body.json));
      } else if (body !== null) {
        headers['content-type'] = 'application/dicom';
        bytes = Uint8Array.from(atob(body.dicom), (character) => character.charCodeAt(0));
      }
      const answer = await library.request({ request, method, path, headers, body: bytes });
      if ('failed' in answer) throw new Error(`The library did not answer: ${answer.failed}`);
      const text = new TextDecoder().decode(answer.body);
      let said: unknown = text;
      try {
        said = JSON.parse(text);
      } catch {
        // Not JSON: the text will do for a message.
      }
      return { status: answer.status, said };
    },
    { name: BRIDGE_GLOBAL, method, path, body },
  );
}

interface JobSaid {
  readonly id: string;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string | null;
  readonly failure: unknown;
  readonly result: Record<string, unknown> | null;
}

/** Submit a job and wait for its end, saying how long it took. */
async function run(kind: string, inputs: Record<string, unknown>): Promise<JobSaid> {
  const began = Date.now();
  const submitted = await ask('POST', '/api/v1/jobs', { json: { kind, inputs } });
  expect(submitted.status, JSON.stringify(submitted.said)).toBe(202);
  const { id } = submitted.said as JobSaid;
  let most = 0;
  for (;;) {
    const job = (await ask('GET', `/api/v1/jobs/${id}`)).said as JobSaid;
    most = Math.max(most, job.progress ?? 0);
    if (job.status !== 'queued' && job.status !== 'running') {
      console.log(
        `${kind}: ${job.status} after ${((Date.now() - began) / 1000).toFixed(1)} s ` +
          `(progress seen up to ${Math.round(most * 100)}%)`,
      );
      if (job.status !== 'succeeded') {
        // What the tool said is the job's log; it is of a synthetic phantom.
        const log = await ask('GET', `/api/v1/jobs/${id}/log`);
        throw new Error(
          `${job.status}: ${JSON.stringify(job.failure)} ${job.message} ` +
            JSON.stringify(log.said).slice(0, 2000),
        );
      }
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test('the library in it has the registration jobs: the native tools were packed', async () => {
  const kinds = (await ask('GET', '/api/v1/job-kinds')).said as { items: { name: string }[] };
  expect(kinds.items.map((kind) => kind.name)).toEqual([
    'rigid-registration',
    'deformable-registration',
  ]);
  const presets = (await ask('GET', '/api/v1/registration-presets')).said as {
    items: { name: string }[];
  };
  expect(presets.items.map((preset) => preset.name)).toEqual(['cbct-ct', 'ct-ct', 'mr-ct']);
});

test('it registers two series a known offset apart, with no server', async () => {
  test.setTimeout(600_000);
  const pair = knownOffsetPair();
  for (const file of [...pair.fixed, ...pair.moving]) {
    const stored = await ask('POST', '/api/v1/instances', {
      dicom: Buffer.from(file.bytes).toString('base64'),
    });
    expect(stored.status, JSON.stringify(stored.said)).toBe(201);
  }
  const inputs = {
    fixedSeriesUid: KNOWN_OFFSET_SERIES.fixed,
    movingSeriesUid: KNOWN_OFFSET_SERIES.moving,
    seed: 7,
  };

  // Rigid: the tool has to find the offset, to the millimetre at the corners.
  const rigid = await run('rigid-registration', inputs);
  const found = (rigid.result as { fixedToMoving: number[] }).fixedToMoving;
  const error = knownOffsetError(found);
  console.log(
    `rigid: ${error.toFixed(3)} mm at worst at the corners, of an offset of ` +
      `${Math.hypot(...KNOWN_OFFSET).toFixed(1)} mm`,
  );
  expect(error).toBeLessThanOrEqual(1);

  // Deformable, as someone would: from where the rigid registration ended.
  // The tool reads a preset from beside it, by a path with spaces in it on
  // every system. It has to run to its end and fold nothing. Its field is
  // not judged here: how little it may move this pair, which differs by
  // nothing, is held to a tolerance by the server's test with the tools
  // (#351), and how well a real deformation is found by the tools' own
  // tests, on a phantom made for that.
  const deformable = await run('deformable-registration', {
    ...inputs,
    preset: 'mr-ct',
    initial: found,
  });
  const field = deformable.result as {
    fieldSize: number[];
    largestMm: number;
    insidePoints: number;
    largestInsideMm: number;
    meanInsideMm: number;
    foldedPoints: number;
  };
  console.log(
    `deformable: field ${field.fieldSize.join(' x ')}, longest vector ${field.largestMm} mm, ` +
      `inside the outline ${field.largestInsideMm} mm at most and ${field.meanInsideMm} mm on ` +
      `average at ${field.insidePoints} points, ${field.foldedPoints} folded points`,
  );
  expect(field.fieldSize).toHaveLength(3);
  expect(field.foldedPoints).toBe(0);
  // The tools packed are ones that say what the field is inside the outline (#351).
  expect(field.insidePoints).toBeGreaterThan(0);
  expect(field.largestInsideMm).toBeLessThanOrEqual(field.largestMm);

  // Both were stored in the library, beside the images.
  const counts = (await ask('GET', '/api/v1/counts')).said as { instances: number };
  expect(counts.instances).toBe(pair.fixed.length + pair.moving.length + 2);
  expect(problems).toEqual([]);
});
