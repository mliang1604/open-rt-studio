/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { standInKeychainArgs } from '../e2e/keychain.js';

// No test starts the application on the keychain of whoever runs it (#357):
// on a Mac that had the system ask its user, again and again, whether the
// application may use a key the test itself had put there.

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));

describe('the tests that start the application', () => {
  it('start it with a stand-in for the keychain, every one of them', async () => {
    const starting: string[] = [];
    for (const folder of ['e2e', 'installed']) {
      for (const name of await readdir(join(DESKTOP, folder))) {
        if (!name.endsWith('.ts')) continue;
        const text = await readFile(join(DESKTOP, folder, name), 'utf8');
        if (!/\belectron\.launch\(/.test(text)) continue;
        starting.push(`${folder}/${name}`);
        expect(text, `${folder}/${name} starts the application`).toContain(
          '...standInKeychainArgs()',
        );
        // And by that alone: a switch written out here is one that is forgotten elsewhere.
        expect(text, `${folder}/${name}`).not.toMatch(/use-mock-keychain|password-store/);
      }
    }
    expect(starting.sort()).toEqual([
      'e2e/files.spec.ts',
      'e2e/library.spec.ts',
      'e2e/server.spec.ts',
      'e2e/shell.spec.ts',
      'installed/installed.spec.ts',
    ]);
  });

  it('gives the stand-in that the system it runs on has', () => {
    const args = standInKeychainArgs();
    if (process.platform === 'darwin') expect(args).toEqual(['--use-mock-keychain']);
    else if (process.platform === 'linux') expect(args).toEqual(['--password-store=basic']);
    else expect(args).toEqual([]);
  });
});
