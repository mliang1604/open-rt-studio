/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The library on this computer (#64): the server of this repository inside
// the main process, with its PACS in the profile. The page asks its API
// through the bridge, as it asks a server's; no port is opened for it and
// there is no login, since whoever runs the application is its one user.
//
// A folder is taken into the library here, from the disk: the user chooses
// it in the system's dialog, and the page is told how the import went and
// never where the folder was. This needs no Electron.
//
// With the native tools (#70) the library registers images as a server
// does, by the same jobs. Where the tools are is the application's to say,
// from where it was installed; no request and no setting of the page names
// a program.

import { join, resolve } from 'node:path';

import {
  isServerRequest,
  type LibraryImportResult,
  type LibraryProgress,
  type ServerAnswer,
  type ServerRequest,
} from '@open-rt-studio/desktop-bridge';
import {
  createLogger,
  errorFields,
  hasNativeTools,
  openEmbeddedServer,
  type EmbeddedServer,
  type Logger,
} from '@open-rt-studio/server';

/** Where an installer puts the native tools, from the folder of the application's resources. */
export const NATIVE_TOOLS_IN_RESOURCES = ['native', 'bin'] as const;

/**
 * Where the native tools of this application are. An installed application
 * has them in its own resources and looks nowhere else; one run from the
 * repository has those a setting names, or none.
 */
export function nativeToolsDirectory(where: {
  /** The folder of an installed application's resources; null when it is not installed. */
  readonly resources: string | null;
  /** What the setting for working on the application says. */
  readonly named: string | undefined;
}): string | null {
  if (where.resources !== null) return join(where.resources, ...NATIVE_TOOLS_IN_RESOURCES);
  return where.named === undefined || where.named === '' ? null : resolve(where.named);
}

export interface LibraryOptions {
  /** Where the library is kept: a folder of the profile. */
  readonly directory: string;
  /** Ask the user for a folder to take in, in the system's dialog. Null when none was chosen. */
  pickFolder(): Promise<string | null>;
  /**
   * The directory of the native tools this application came with, or null:
   * with them the library has the registration jobs. A directory that does
   * not hold them all is as none, and the library opens without the jobs.
   */
  readonly nativeTools?: string | null;
  /** Where its log goes. Warnings and errors to the standard output without. */
  readonly logger?: Logger;
  /** How the server is opened; a spec gives its own. */
  readonly open?: (
    directory: string,
    logger: Logger,
    nativeTools: string | null,
  ) => Promise<EmbeddedServer>;
}

export interface Library {
  request(request: ServerRequest): Promise<ServerAnswer>;
  cancel(request: string): void;
  importFolder(): Promise<LibraryImportResult>;
  importProgress(): LibraryProgress | null;
  cancelImport(): void;
  /** Finish what is under way and close the library. Asking again gives the first answer. */
  stop(): Promise<void>;
}

/** How long closing waits for work in flight before it gives it up. */
const STOP_TIMEOUT_MS = 5000;

/**
 * Open the library. It is opened at once and not waited for: the
 * application starts whether or not it can be, and a library that could not
 * be opened answers every request as one that cannot be reached.
 */
export function openLibrary(options: LibraryOptions): Library {
  // No identifier reaches the log: the server's logger sees to that.
  const logger = options.logger ?? createLogger({ level: 'warn' });
  const open =
    options.open ??
    ((directory, log, nativeTools) =>
      openEmbeddedServer(
        { dataDir: directory, shutdownTimeoutMs: STOP_TIMEOUT_MS, nativeTools },
        log,
      ));
  // Asked first: a server told of tools that are not there does not open,
  // and a library without registration is better than no library.
  let nativeTools = options.nativeTools ?? null;
  if (nativeTools !== null && !hasNativeTools(nativeTools)) {
    // Not where: that is of no use to a reader of the log, and a profile's path can name a person.
    logger.warn('library-without-native-tools');
    nativeTools = null;
  }
  const opened: Promise<EmbeddedServer | null> = open(options.directory, logger, nativeTools).catch(
    (error: unknown) => {
      logger.error('library-not-opened', errorFields(error));
      return null;
    },
  );
  /** The requests that have not been answered, by the name the page gave them. */
  const pending = new Map<string, AbortController>();
  /** The import under way. */
  let importing: { progress: LibraryProgress | null; readonly control: AbortController } | null =
    null;
  let stopped: Promise<void> | null = null;

  return {
    async request(request) {
      // Checked where it arrives as well as where it is served.
      if (!isServerRequest(request)) return { failed: 'unreachable' };
      const server = await opened;
      if (server === null || stopped !== null) return { failed: 'unreachable' };
      const control = new AbortController();
      pending.set(request.request, control);
      try {
        const answer = await server.ask(
          {
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body,
          },
          control.signal,
        );
        if (control.signal.aborted) return { failed: 'cancelled' };
        // Bytes of their own: a view into memory that holds other things
        // would take those across the bridge with it.
        return {
          status: answer.status,
          headers: answer.headers,
          body: new Uint8Array(answer.body),
        };
      } catch (error) {
        logger.error('library-request-failed', errorFields(error));
        return { failed: 'unreachable' };
      } finally {
        pending.delete(request.request);
      }
    },

    cancel(request) {
      pending.get(request)?.abort();
    },

    async importFolder() {
      if (importing !== null) return { not: 'busy' };
      // Taken before the dialog is shown: a second call while it is open is refused.
      const mine = { progress: null as LibraryProgress | null, control: new AbortController() };
      importing = mine;
      try {
        const server = await opened;
        if (server === null || server.core.pacs === null || stopped !== null) {
          return { not: 'unavailable' };
        }
        const folder = await options.pickFolder();
        if (folder === null) return { not: 'chosen' };
        mine.progress = { done: 0, total: 0 };
        const summary = await server.core.pacs.ingest.importFolder(folder, {
          signal: mine.control.signal,
          onProgress: ({ done, total }) => {
            mine.progress = { done, total };
          },
        });
        logger.info('library-import', {
          files: summary.total,
          stored: summary.stored,
          refused: summary.refused.length,
          failed: summary.failed.length,
        });
        return {
          imported: {
            total: summary.total,
            stored: summary.stored,
            unchanged: summary.unchanged,
            replaced: summary.replaced,
            // How many, and not which: a name of a file can be a name of a patient.
            refused: summary.refused.length,
            failed: summary.failed.length,
            cancelled: summary.cancelled,
          },
        };
      } catch (error) {
        logger.error('library-import-failed', errorFields(error));
        return { not: 'unavailable' };
      } finally {
        importing = null;
      }
    },

    importProgress: () => importing?.progress ?? null,

    cancelImport() {
      importing?.control.abort();
    },

    stop() {
      stopped ??= (async () => {
        importing?.control.abort();
        for (const control of pending.values()) control.abort();
        const server = await opened;
        await server?.stop().catch((error: unknown) => {
          logger.error('library-not-closed', errorFields(error));
        });
      })();
      return stopped;
    },
  };
}
