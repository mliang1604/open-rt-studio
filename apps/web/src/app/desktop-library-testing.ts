/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for the desktop application's library, for specs: it sends
// what it is asked to a `fetch` it is given (a stand-in server's, which is
// what the library is), and "imports" what a spec says a folder held.

import type {
  DesktopLibrary,
  LibraryImportResult,
  LibraryProgress,
  ServerAnswer,
  ServerRequest,
} from '@open-rt-studio/desktop-bridge';

import { LIBRARY_ADDRESS } from './desktop-library';

export interface FakeDesktopLibrary extends DesktopLibrary {
  /** Every request, as the page made it. */
  readonly requests: ServerRequest[];
  /** The requests the page gave up. */
  readonly cancelled: string[];
  /** True for a library that could not be opened. */
  broken: boolean;
  /** How often an import was asked for. */
  imports: number;
  /** How often an import was asked to stop. */
  stops: number;
  /**
   * What the next import does: it is called when the user "chose a folder",
   * and what it resolves with is the import's answer. Without one, no folder
   * is chosen.
   */
  onImport: (() => Promise<LibraryImportResult>) | null;
  /** What the library says of an import under way. */
  progress: LibraryProgress | null;
}

export function fakeDesktopLibrary(fetcher: typeof fetch): FakeDesktopLibrary {
  const fake: FakeDesktopLibrary = {
    requests: [],
    cancelled: [],
    broken: false,
    imports: 0,
    stops: 0,
    onImport: null,
    progress: null,
    request: async (request): Promise<ServerAnswer> => {
      fake.requests.push(request);
      if (fake.broken) return { failed: 'unreachable' };
      let response: Response;
      try {
        response = await fetcher(`${LIBRARY_ADDRESS}${request.path}`, {
          method: request.method,
          headers: request.headers,
          // The stand-in server reads JSON as the text a page sends it.
          body:
            request.body === null
              ? undefined
              : request.headers['content-type'] === 'application/json'
                ? new TextDecoder().decode(request.body)
                : new Uint8Array(request.body),
        });
      } catch {
        return { failed: 'unreachable' };
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((text, name) => (headers[name] = text));
      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
    cancel: async (request) => {
      fake.cancelled.push(request);
      return null;
    },
    importFolder: async () => {
      fake.imports += 1;
      if (fake.broken) return { not: 'unavailable' };
      return fake.onImport ? fake.onImport() : { not: 'chosen' };
    },
    importProgress: async () => fake.progress,
    cancelImport: async () => {
      fake.stops += 1;
      return null;
    },
  };
  return fake;
}
