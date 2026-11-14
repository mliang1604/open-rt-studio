/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

import { fileURLToPath } from 'node:url';

import { InvalidJobInputError, type JobKind } from '../job.js';

const WORKER = fileURLToPath(new URL('./dummy-worker.mjs', import.meta.url));

const ALLOWED = new Set([
  ...['steps', 'delayMs', 'exitCode', 'result', 'stderr', 'writeFile'],
  ...['ignoreTerm', 'chatter', 'echo'],
]);

/**
 * A job kind that runs the dummy worker with Node. It checks its inputs the
 * way a real kind must: only the names it knows, each of the type it takes.
 */
export function dummyKind(
  options: { readonly timeoutMs?: number; readonly name?: string } = {},
): JobKind {
  return {
    name: options.name ?? 'dummy',
    description: 'Counts steps and does nothing else. For tests.',
    timeoutMs: options.timeoutMs,
    command(inputs) {
      for (const name of Object.keys(inputs)) {
        if (!ALLOWED.has(name)) throw new InvalidJobInputError('The dummy job has no such input.');
      }
      const steps = inputs['steps'] ?? 0;
      if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 0 || steps > 1000) {
        throw new InvalidJobInputError('steps must be a whole number from 0 to 1000.');
      }
      const file = inputs['writeFile'];
      if (file !== undefined && (typeof file !== 'string' || !/^[a-z0-9.-]+$/.test(file))) {
        throw new InvalidJobInputError('writeFile must be a plain file name.');
      }
      // One argument, given to the program as it is: no shell reads it.
      return { file: process.execPath, args: [WORKER, JSON.stringify(inputs)] };
    },
  };
}
