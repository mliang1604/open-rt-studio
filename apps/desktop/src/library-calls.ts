/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge's calls about the library on this computer (#64), answered from it.

import { isGrantId, isServerRequest } from '@open-rt-studio/desktop-bridge';

import type { Answers } from './ipc.js';
import type { Library } from './library.js';

type LibraryChannel =
  | 'library:request'
  | 'library:cancel'
  | 'library:import-folder'
  | 'library:import-progress'
  | 'library:cancel-import';

const nothing = (args: readonly unknown[]): boolean => args.length === 0;

export function libraryAnswers(library: Library): Pick<Answers, LibraryChannel> {
  return {
    'library:request': {
      accepts: (args) => args.length === 1 && isServerRequest(args[0]),
      answer: (request) => library.request(request),
    },
    'library:cancel': {
      accepts: (args) => args.length === 1 && isGrantId(args[0]),
      answer: (request) => {
        library.cancel(request);
        return null;
      },
    },
    // It takes nothing: which folder is the user's to say, in the main process's dialog.
    'library:import-folder': { accepts: nothing, answer: () => library.importFolder() },
    'library:import-progress': { accepts: nothing, answer: () => library.importProgress() },
    'library:cancel-import': {
      accepts: nothing,
      answer: () => {
        library.cancelImport();
        return null;
      },
    },
  };
}
