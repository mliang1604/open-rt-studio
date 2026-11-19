/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// No test starts the application on the keychain of whoever runs it (#357).
// The application seals a server's login with a key the system keeps for
// it, and on macOS an entry made by one build is not another build's to
// read while neither is signed by anyone: the system asks, in a dialog no
// test can answer and the developer did not expect.

/**
 * Chromium switches that give the application a stand-in for the system's
 * store of secrets, to add to its arguments in every test that starts it:
 * on macOS a keychain of Chromium's own, with a key that is the same
 * everywhere and protects nothing; on Linux the plain store, which the
 * application takes for no protection at all. On Windows the key is the
 * user's own and nothing is asked or written.
 */
export function standInKeychainArgs(): string[] {
  if (process.platform === 'darwin') return ['--use-mock-keychain'];
  if (process.platform === 'linux') return ['--password-store=basic'];
  return [];
}
