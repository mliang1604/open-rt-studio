/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileFor, respond } from './content.js';
import { APP_HOME, contentSecurityPolicy } from './policy.js';

const POLICY = contentSecurityPolicy();
let scratch: string;
/** A build, and beside it a file the page must never be given. */
let root: string;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'open-rt-studio-content-')));
  root = join(scratch, 'browser');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><app-root></app-root>');
  await writeFile(join(root, 'main-ABC123.js'), 'export {};');
  await writeFile(join(root, 'styles.css'), 'body{margin:0}');
  await writeFile(join(root, 'assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'assets', 'data.bin'), new Uint8Array([0, 1, 2, 255]));
  await writeFile(join(scratch, 'secret.txt'), 'not for the page');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const get = (path: string, method = 'GET') => respond(root, method, `${APP_HOME}${path}`, POLICY);

describe("the application's files", () => {
  it('are given as what they are, with the policy on every answer', async () => {
    const index = await get('');
    expect(index.status).toBe(200);
    expect(index.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('Content-Security-Policy')).toBe(POLICY);
    expect(index.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await index.text()).toContain('<app-root>');

    const script = await get('main-ABC123.js');
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('Content-Security-Policy')).toBe(POLICY);
    expect((await get('styles.css')).headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect((await get('assets/mark.svg')).headers.get('Content-Type')).toBe('image/svg+xml');

    const bytes = await get('assets/data.bin');
    expect(bytes.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(bytes.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
  });

  it('give the index for a page of the application, and 404 for a file that is not there', async () => {
    for (const page of ['disclaimer', 'declined', 'some/deeper/page', 'assets']) {
      const answer = await get(page);
      expect(answer.status, page).toBe(200);
      expect(await answer.text(), page).toContain('<app-root>');
    }
    for (const missing of ['main-OLD.js', 'assets/nothing.svg', 'favicon.ico']) {
      const answer = await get(missing);
      expect(answer.status, missing).toBe(404);
      expect(await answer.text()).toBe('');
      expect(answer.headers.get('Content-Security-Policy')).toBe(POLICY);
    }
  });

  it('answer a question about a file without its bytes, and nothing that would change one', async () => {
    const head = await get('styles.css', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('14');
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect((await get('styles.css', method)).status, method).toBe(405);
    }
  });

  it('never leave the build, however the address is written', async () => {
    for (const address of [
      `${APP_HOME}..%2Fsecret.txt`,
      `${APP_HOME}%2e%2e%2fsecret.txt`,
      `${APP_HOME}assets/..%2F..%2Fsecret.txt`,
      `${APP_HOME}assets%2F..%2F..%2Fsecret.txt`,
      `${APP_HOME}..%5Csecret.txt`,
      `${APP_HOME}assets/..%5C..%5Csecret.txt`,
      `${APP_HOME}%2Fetc%2Fpasswd.txt`,
      `${APP_HOME}C:%5CWindows%5Cwin.ini`,
      `${APP_HOME}index.html::$DATA`,
      `${APP_HOME}index.html%00.js`,
      `${APP_HOME}%E0%A4%A.txt`,
    ]) {
      const file = await fileFor(root, address);
      expect([400, 404], address).toContain(file);
      const answer = await respond(root, 'GET', address, POLICY);
      expect(answer.status, address).toBeGreaterThanOrEqual(400);
      expect(await answer.text(), address).toBe('');
    }
    // What the address parser folds away before we see it stays in the build too.
    for (const folded of [`${APP_HOME}../secret.txt`, `${APP_HOME}assets/../../secret.txt`]) {
      expect(await fileFor(root, folded), folded).toBe(404);
    }
    // An absolute path in the address is a path in the build.
    expect(await fileFor(root, `${APP_HOME}/${join(scratch, 'secret.txt')}`)).toBe(404);
  });

  it.skipIf(process.platform === 'win32')('do not follow a link out of the build', async () => {
    await symlink(join(scratch, 'secret.txt'), join(root, 'assets', 'linked.txt'));
    try {
      expect(await fileFor(root, `${APP_HOME}assets/linked.txt`)).toBe(404);
      expect((await get('assets/linked.txt')).status).toBe(404);
    } finally {
      await rm(join(root, 'assets', 'linked.txt'));
    }
  });

  it("are the application's only: another scheme or host gets nothing", async () => {
    for (const address of [
      'app://other/index.html',
      'app://open-rt-studio.example.org/index.html',
      'https://open-rt-studio/index.html',
      'file:///index.html',
      'index.html',
      '',
    ]) {
      expect(await fileFor(root, address), address).toBe(404);
    }
  });

  it('give 404 when there is no build', async () => {
    const answer = await respond(join(scratch, 'nothing'), 'GET', APP_HOME, POLICY);
    expect(answer.status).toBe(404);
  });
});
