/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge's calls about files (#62), answered from the grants. The only
// way a place on the disk becomes a grant is the system's dialog, which the
// user answers: a call asks for the dialog and never names a place.

import { grantPathParts, isGrantId } from '@open-rt-studio/desktop-bridge';

import type { Grants } from './grants.js';
import type { Answers } from './ipc.js';

/** The system's dialogs: what the user chose, or null when they chose nothing. */
export interface Pickers {
  folder(): Promise<string | null>;
  files(): Promise<readonly string[] | null>;
}

type FileChannel =
  | 'files:pick-folder'
  | 'files:pick-files'
  | 'files:list'
  | 'files:read'
  | 'files:keep'
  | 'files:forget';

const none = (args: readonly unknown[]): boolean => args.length === 0;
const oneId = (args: readonly unknown[]): boolean => args.length === 1 && isGrantId(args[0]);
const whole = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

export function fileAnswers(grants: Grants, pick: Pickers): Pick<Answers, FileChannel> {
  // One dialog at a time: a second call while one is open is as if it was dismissed.
  let asking = false;
  const ask = async <T>(dialog: () => Promise<T | null>): Promise<T | null> => {
    if (asking) return null;
    asking = true;
    try {
      return await dialog();
    } finally {
      asking = false;
    }
  };
  return {
    'files:pick-folder': {
      accepts: none,
      answer: async () => {
        const chosen = await ask(pick.folder);
        return chosen === null ? null : grants.folder(chosen);
      },
    },
    'files:pick-files': {
      accepts: none,
      answer: async () => {
        const chosen = await ask(pick.files);
        return chosen === null ? null : grants.files(chosen);
      },
    },
    'files:list': { accepts: oneId, answer: (id) => grants.list(id) },
    'files:read': {
      accepts: (args) =>
        args.length === 4 &&
        isGrantId(args[0]) &&
        grantPathParts(args[1]) !== null &&
        whole(args[2]) &&
        whole(args[3]),
      answer: (id, path, offset, length) => grants.read(id, path, offset, length),
    },
    'files:keep': { accepts: oneId, answer: (id) => grants.keep(id) },
    'files:forget': {
      accepts: oneId,
      answer: async (id) => {
        await grants.forget(id);
        return null;
      },
    },
  };
}
