/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The application's own files, as the page asks for them (#61): the web
// client's build, served under `app://open-rt-studio/`. A request reaches a
// file of that build or nothing. This needs no Electron, so it is tested as
// it is.

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

import { APP_HOST, APP_SCHEME } from './policy.js';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const INDEX = 'index.html';

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The file of the build a request's address names, or null: a status to
 * answer with instead.
 *
 * An address that names no file and looks like a page of the application
 * (its last part has no extension) gets the index, as the application
 * routes in the page. One that looks like a file and is not there is 404.
 */
export async function fileFor(root: string, address: string): Promise<string | 400 | 404> {
  const url = URL.parse(address);
  if (url === null || url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return 404;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return 400;
  }
  const parts = path.split('/').filter((part) => part !== '');
  // Nothing that could leave the build on any system: a step up, another
  // separator, a drive or a stream of a file, or the end of a C string.
  if (parts.some((part) => part === '..' || part === '.' || /[\\:\0]/.test(part))) return 400;

  const wanted = join(root, ...parts);
  const last = parts.at(-1) ?? '';
  let file: string;
  if (parts.length > 0 && (await isFile(wanted))) file = wanted;
  else if (extname(last) === '') file = join(root, INDEX);
  else return 404;

  // A link in the build that leads out of it is not followed.
  try {
    const [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    if (!real.startsWith(realRoot + sep)) return 404;
    return real;
  } catch {
    return 404;
  }
}

/**
 * Answer a request for one of the application's files. Every answer carries
 * the content security policy and says what kind of file it is, which the
 * page is not left to guess.
 */
export async function respond(
  root: string,
  method: string,
  address: string,
  policy: string,
): Promise<Response> {
  const headers = {
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  };
  const refuse = (status: number) =>
    new Response(null, { status, headers: { ...headers, 'Content-Type': 'text/plain' } });
  if (method !== 'GET' && method !== 'HEAD') return refuse(405);
  const file = await fileFor(root, address);
  if (typeof file === 'number') return refuse(file);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return refuse(404);
  }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  return new Response(method === 'HEAD' ? null : new Uint8Array(bytes), {
    status: 200,
    headers: { ...headers, 'Content-Type': type, 'Content-Length': String(bytes.length) },
  });
}
