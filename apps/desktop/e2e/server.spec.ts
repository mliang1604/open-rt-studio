/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A server from the desktop application (#63), as it runs: the real server
// of this repository with one account, and the application connecting to
// it, logging in and loading a series.
//
// The first tests ask through the bridge, as the page does, and run
// everywhere. The last go through the application's own card, which needs
// the viewer and so a GPU: they are skipped on a machine without one.
//
// A test cannot answer the main process's dialog, so it is replaced by one
// that answers as the user would. And the system's keychain is not the
// test's to write to: Chromium is given a stand-in for it where it has one.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_GLOBAL,
  HELD_LOGIN,
  type DesktopBridge,
  type ServerAnswer,
  type ServerConnection,
} from '@open-rt-studio/desktop-bridge';
import { syntheticThoraxPatient, THORAX_PATIENT } from '@open-rt-studio/testdata';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { draws, gpuArgs, gpuEnv, gpuOffer } from './gpu.js';
import { startTestServer, type TestServer } from './test-server.js';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = { name: 'ada', password: 'correct horse battery staple' };

test.describe.configure({ mode: 'serial' });

let server: TestServer;
let profile: string;
let application: ElectronApplication;
let page: Page;

async function start(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  const args = [DESKTOP];
  // Not the user's keychain: Chromium's stand-in on macOS, and on Linux its
  // plain store, which the application takes for no protection at all.
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (process.platform === 'linux') args.push('--password-store=basic');
  args.push(...gpuArgs());
  application = await electron.launch({
    args,
    cwd: DESKTOP,
    env: { ...env, ...gpuEnv(), OPEN_RT_STUDIO_DESKTOP_USER_DATA: profile },
  });
  page = await application.firstWindow();
  await expect(page.locator('app-root')).toBeAttached();
}

/** Have the main process's question about a server answered, and keep what it asked. */
async function answerQuestions(agree: boolean): Promise<void> {
  await application.evaluate(
    ({ dialog }, response) => {
      const asked = globalThis as Record<string, unknown>;
      asked['__questions'] = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message: string; detail?: string };
        (asked['__questions'] as string[]).push(`${options.message}\n${options.detail ?? ''}`);
        return { response, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    },
    agree ? 0 : 1,
  );
}
const questions = (): Promise<string[]> =>
  application.evaluate(() => (globalThis as Record<string, unknown>)['__questions'] as string[]);

/** Whether this system protects a secret for the application, as its main process judges it. */
const protects = (): Promise<boolean> =>
  application.evaluate(
    ({ safeStorage }) =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  );

/** Whether the viewer draws here: a GPU, or software that was asked for. */
const hasGpu = async (): Promise<boolean> => draws(await gpuOffer(page));

/** Ask the server through the bridge, as the page does, and read the answer as JSON. */
async function ask(
  connection: string,
  method: string,
  path: string,
  body: unknown = null,
): Promise<{ status: number | null; failed: string | null; said: unknown }> {
  return page.evaluate(
    async ([name, id, how, where, what]) => {
      const { server } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const request = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const answer = (await server.request(id, {
        request,
        method: how as 'GET',
        path: where,
        headers: what === null ? {} : { 'content-type': 'application/json' },
        body: what === null ? null : new TextEncoder().encode(JSON.stringify(what)),
      })) as ServerAnswer | null;
      if (answer === null) return { status: null, failed: 'no connection', said: null };
      if ('failed' in answer) return { status: null, failed: answer.failed, said: null };
      let said: unknown;
      try {
        said = JSON.parse(new TextDecoder().decode(answer.body));
      } catch {
        said = answer.body.byteLength;
      }
      return { status: answer.status, failed: null, said };
    },
    [BRIDGE_GLOBAL, connection, method, path, body] as const,
  );
}

const connectTo = (address: string): Promise<ServerConnection | null> =>
  page.evaluate(
    ([name, where]) =>
      ((globalThis as Record<string, unknown>)[name] as DesktopBridge).server.connect(where),
    [BRIDGE_GLOBAL, address] as const,
  );
const connections = (): Promise<readonly ServerConnection[]> =>
  page.evaluate(
    (name) => ((globalThis as Record<string, unknown>)[name] as DesktopBridge).server.connections(),
    BRIDGE_GLOBAL,
  );

const saved = async (): Promise<{ address: string; login?: string }[]> => {
  try {
    const kept = JSON.parse(await readFile(join(profile, 'server-connections.json'), 'utf8')) as {
      connections: { address: string; login?: string }[];
    };
    return kept.connections;
  } catch {
    return [];
  }
};

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'open-rt-studio-desktop-server-profile-'));
  server = await startTestServer(ACCOUNT);
  // Generated here, as all test data is.
  await server.upload(syntheticThoraxPatient({ size: 48, slices: 16 }));
});

test.afterAll(async () => {
  await application?.close();
  await server?.remove();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    () => undefined,
  );
});

test('a server is put to the user first, and a refusal sends nothing', async () => {
  await start();
  await answerQuestions(false);
  expect(await connectTo(server.address)).toBeNull();
  const [asked] = await questions();
  expect(asked).toContain(`Connect to ${server.address}?`);
  // On this machine: nothing to warn of.
  expect(asked).not.toContain('not encrypted');
  expect(await connections()).toEqual([]);

  // A server elsewhere over http is asked about with what that means, and what is no address is not asked about.
  expect(await connectTo('http://pacs.example.invalid:4300')).toBeNull();
  expect((await questions())[1]).toContain('not encrypted (http)');
  expect(await connectTo('file:///etc/passwd')).toBeNull();
  expect(await connectTo('not an address')).toBeNull();
  expect(await questions()).toHaveLength(2);
  expect(await saved()).toEqual([]);

  // The page itself still reaches nothing: its policy has not been opened.
  const direct = await page.evaluate(
    (address) =>
      fetch(`${address}/api/v1/session`).then(
        () => 'answered',
        () => 'refused',
      ),
    server.address,
  );
  expect(direct).toBe('refused');
});

test('through the bridge: a login whose token stays in the main process', async () => {
  await answerQuestions(true);
  const connection = (await connectTo(server.address))!;
  expect(connection).toMatchObject({ address: server.address, loggedIn: false });
  expect(await questions()).toHaveLength(1);
  // A second time it is a server the user knows: not asked again.
  expect((await connectTo(`${server.address}/`))!.id).toBe(connection.id);
  expect(await questions()).toHaveLength(1);

  // Nothing without a login, and a wrong password is the server's to refuse.
  expect((await ask(connection.id, 'GET', '/api/v1/patients')).status).toBe(401);
  const wrong = await ask(connection.id, 'POST', '/api/v1/session', {
    name: ACCOUNT.name,
    password: 'not the password at all',
  });
  expect(wrong.status).toBe(401);

  const login = await ask(connection.id, 'POST', '/api/v1/session', ACCOUNT);
  expect(login.status).toBe(200);
  // The page is told who it is, and given a marker where the token was.
  expect(login.said).toMatchObject({ token: HELD_LOGIN, account: { name: ACCOUNT.name } });
  expect(await server.statusWith(HELD_LOGIN)).toBe(401);
  expect(await connections()).toEqual([{ ...connection, loggedIn: true }]);

  // With nothing said of who asks, the server answers the one who logged in.
  const patients = await ask(connection.id, 'GET', '/api/v1/patients?limit=10');
  expect(patients.status).toBe(200);
  expect(patients.said).toMatchObject({ items: [{ patientId: THORAX_PATIENT.id }] });

  // Only the server's API, and only of a server that was agreed to.
  const outside = await page.evaluate(
    async ([name, id]) => {
      const { server: bridge } = (globalThis as Record<string, unknown>)[name] as DesktopBridge;
      const tried = (path: string, connection = id) =>
        bridge
          .request(connection, {
            request: 'Zm9sZGVyLW9mLXRlc3RzIQ',
            method: 'GET',
            path,
            headers: {},
            body: null,
          })
          .then(
            (answer) => (answer === null ? 'nothing' : 'answered'),
            () => 'refused',
          );
      return {
        health: await tried('/health'),
        up: await tried('/api/v1/../../health'),
        elsewhere: await tried('//elsewhere.invalid/api/v1/session'),
        unknown: await tried('/api/v1/session', 'bm90LWEtY29ubmVjdGlvbg'),
        named: await bridge
          .request(id, {
            request: 'Zm9sZGVyLW9mLXRlc3RzIQ',
            method: 'GET',
            path: '/api/v1/session',
            headers: { authorization: 'Bearer of-the-page' },
            body: null,
          })
          .then(
            () => 'answered',
            () => 'refused',
          ),
      };
    },
    [BRIDGE_GLOBAL, connection.id] as const,
  );
  expect(outside).toEqual({
    health: 'refused',
    up: 'refused',
    elsewhere: 'refused',
    unknown: 'nothing',
    named: 'refused',
  });
});

test('through the bridge: the login is there after a restart, where the system protects it', async () => {
  const protectedHere = await protects();
  await application.close();
  const [kept] = await saved();
  expect(kept.address).toBe(server.address);
  // Written down only sealed, and only where there is something to seal it with.
  expect(typeof kept.login).toBe(protectedHere ? 'string' : 'undefined');
  expect(JSON.stringify(kept)).not.toContain(ACCOUNT.password);

  await start();
  await answerQuestions(false);
  const [connection] = await connections();
  expect(connection).toMatchObject({ address: server.address, loggedIn: protectedHere });
  // A server the user knows: connected to without a question.
  expect((await connectTo(server.address))!.id).toBe(connection.id);
  expect(await questions()).toEqual([]);
  expect((await ask(connection.id, 'GET', '/api/v1/patients')).status).toBe(
    protectedHere ? 200 : 401,
  );
  test.info().annotations.push({
    type: 'login kept',
    description: `${process.platform}: ${protectedHere ? 'sealed by the system and found again' : 'not written down: nothing here protects it'}`,
  });
});

test('through the bridge: logging out ends the login here and at the server, and a server can be forgotten', async () => {
  const [connection] = await connections();
  if (!connection.loggedIn) await ask(connection.id, 'POST', '/api/v1/session', ACCOUNT);
  expect((await connections())[0].loggedIn).toBe(true);

  expect((await ask(connection.id, 'DELETE', '/api/v1/session')).status).toBeLessThan(300);
  expect((await connections())[0].loggedIn).toBe(false);
  expect((await ask(connection.id, 'GET', '/api/v1/patients')).status).toBe(401);
  expect((await saved())[0].login).toBeUndefined();

  // A server that is not there is said to be unreachable, and nothing more.
  await server.stop();
  expect(await ask(connection.id, 'GET', '/api/v1/session')).toMatchObject({
    status: null,
    failed: 'unreachable',
  });
  await server.start();
  // There again, it answers: that nobody is logged in.
  expect((await ask(connection.id, 'GET', '/api/v1/session')).status).toBe(401);

  await page.evaluate(
    ([name, id]) =>
      ((globalThis as Record<string, unknown>)[name] as DesktopBridge).server.forget(id),
    [BRIDGE_GLOBAL, connection.id] as const,
  );
  expect(await connections()).toEqual([]);
  expect(await saved()).toEqual([]);
  expect((await ask(connection.id, 'GET', '/api/v1/session')).failed).toBe('no connection');
});

test('through the bridge: a server whose certificate is not trusted is not talked to, and it is said why', async () => {
  // The server of this repository over HTTPS, with a certificate made on the spot.
  const untrusted = await startTestServer(ACCOUNT, { https: true });
  try {
    await answerQuestions(true);
    const connection = (await connectTo(untrusted.address))!;
    expect(connection.address).toBe(untrusted.address);
    expect(await ask(connection.id, 'GET', '/api/v1/session')).toMatchObject({
      status: null,
      failed: 'certificate',
    });
    // Not even the login is sent to it.
    expect(await ask(connection.id, 'POST', '/api/v1/session', ACCOUNT)).toMatchObject({
      failed: 'certificate',
    });
    await page.evaluate(
      ([name, id]) =>
        ((globalThis as Record<string, unknown>)[name] as DesktopBridge).server.forget(id),
      [BRIDGE_GLOBAL, connection.id] as const,
    );
  } finally {
    await untrusted.remove();
  }
});

test('in the application: connect, log in and load a series from the server', async () => {
  await page.getByRole('button', { name: /i acknowledge and accept/i }).click();
  await expect(page.locator('header.toolbar')).toBeVisible();
  test.skip(!(await hasGpu()), 'The viewer needs a GPU to show a series: none on this machine.');

  const card = page.locator('app-server-panel');
  await page
    .locator('app-empty-state')
    .getByRole('button', { name: /server…$/ })
    .click();
  await card.getByLabel('Address of an Open RT Studio server').fill(server.address);

  // Refused in the dialog: said so, and nothing is connected.
  await answerQuestions(false);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.locator('.server-problem')).toContainText('Not connected');

  await answerQuestions(true);
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.locator('.server-state')).toContainText('asks for a login');
  await card.getByLabel('Name').fill(ACCOUNT.name);
  await card.getByLabel('Password').fill('not the password at all');
  await card.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(card.locator('.server-problem')).toHaveText(
    'The name or the password is not right.',
  );

  await card.getByLabel('Password').fill(ACCOUNT.password);
  await card.getByRole('button', { name: 'Log in', exact: true }).click();
  // Which server, and as whom.
  await expect(card.locator('.server-state')).toHaveText(
    `Connected: Server at ${new URL(server.address).host}, as ${ACCOUNT.name}.`,
  );
  await expect(card.locator('.browser-study').first()).toContainText(THORAX_PATIENT.id);

  await card.locator('.browser-study').first().click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.history-patient')).toContainText(THORAX_PATIENT.name);
  // The history panel says where the patient is from.
  await expect(page.locator('app-history-panel')).toContainText(
    `Server at ${new URL(server.address).host}`,
  );

  const tile = page.locator('.study-tile').first();
  await tile.click();
  const chip = page.locator('app-series-chip').filter({ hasText: 'CT' }).first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.locator('div.status')).toContainText('volume 48 × 48 × 16', {
    timeout: 60_000,
  });
});

test('in the application: after a restart the server is offered, and the login is still there', async () => {
  test.skip(!(await hasGpu()), 'The viewer needs a GPU to show a series: none on this machine.');
  const protectedHere = await protects();
  await application.close();
  await start();
  await answerQuestions(false);
  await expect(page.locator('header.toolbar')).toBeVisible();

  const card = page.locator('app-server-panel');
  await page
    .locator('app-empty-state')
    .getByRole('button', { name: /server…$/ })
    .click();
  // The address is the one that was used, and it is one of the saved servers.
  await expect(card.getByLabel('Address of an Open RT Studio server')).toHaveValue(server.address);
  await expect(card.getByRole('button', { name: 'Forget' })).toBeVisible();
  await card.getByRole('button', { name: 'Connect' }).click();
  if (protectedHere) {
    await expect(card.locator('.server-state')).toHaveText(
      `Connected: Server at ${new URL(server.address).host}, as ${ACCOUNT.name}.`,
    );
  } else {
    await expect(card.locator('.server-state')).toContainText('asks for a login');
  }
  // It was not asked about again.
  expect(await questions()).toEqual([]);
});
