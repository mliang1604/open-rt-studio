/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The library on this computer (#64): in the desktop application, the server
// of this repository runs inside the main process, with its PACS in the
// profile, and the page asks its API through the bridge. No network is
// involved and there is no login.
//
// To the rest of the application it is a `ServerSource` like any other: the
// same study browser, the same timeline, and what is made in the viewer is
// saved to it as it is to a server.

import { InjectionToken } from '@angular/core';
import {
  desktopBridge,
  type DesktopLibrary,
  type LibraryImport,
  type LibraryImportResult,
} from '@open-rt-studio/desktop-bridge';

import { connectToServer, type ServerSource } from './data-source/server-source';
import { bridgeFetch } from './desktop-server';

/** The desktop application's library; null in a browser. A spec gives a stand-in. */
export const DESKTOP_LIBRARY = new InjectionToken<DesktopLibrary | null>('desktop library', {
  providedIn: 'root',
  factory: () => desktopBridge()?.library ?? null,
});

/**
 * The address the library goes by in the page. It is a name and no place:
 * `.invalid` resolves nowhere, the page's policy lets it fetch from nowhere,
 * and what is asked "there" is asked through the bridge.
 */
export const LIBRARY_ADDRESS = 'http://library.invalid';
export const LIBRARY_LABEL = 'Library on this computer';

/** Whether a source is the library, and not a server. */
export const isLibrary = (source: ServerSource | null): boolean =>
  source?.address === LIBRARY_ADDRESS;

/** Open the library as a source, with its patients listed. Rejects when it could not be opened. */
export function openDesktopLibrary(library: DesktopLibrary): Promise<ServerSource> {
  return connectToServer(LIBRARY_ADDRESS, {
    fetch: bridgeFetch(LIBRARY_ADDRESS, library),
    named: { label: LIBRARY_LABEL, the: 'The library on this computer' },
    unreachable: () => 'The library on this computer could not be opened.',
  });
}

const files = (count: number): string => (count === 1 ? '1 file' : `${count} files`);

/** What an import came to, in a sentence or two for the user. */
export function importSaid(result: LibraryImportResult): string {
  if ('not' in result) {
    switch (result.not) {
      case 'chosen':
        return 'No folder was chosen.';
      case 'busy':
        return 'Another import is under way.';
      case 'unavailable':
        return 'The folder could not be imported: the library could not be opened or the folder could not be read.';
      default: {
        const exhaustive: never = result.not;
        return exhaustive;
      }
    }
  }
  const { total, stored, unchanged, replaced, refused, failed, cancelled }: LibraryImport =
    result.imported;
  if (total === 0) return 'The folder holds no files.';
  const parts = [`${files(stored)} added`];
  if (replaced > 0) parts.push(`${replaced} replaced`);
  if (unchanged > 0) parts.push(`${unchanged} already there`);
  if (refused > 0)
    parts.push(`${refused} not taken (not DICOM, or not an object the library keeps)`);
  if (failed > 0) parts.push(`${failed} could not be read`);
  return `${cancelled ? 'Stopped' : 'Imported'}: ${parts.join(', ')}, of ${files(total)}.`;
}
