/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createIngest, type Ingest } from '../ingest/ingest.js';
import type { JobManager } from '../jobs/job-manager.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import type { DicomStore } from '../store/dicom-store.js';
import { SERVER_VERSION } from '../version.js';

/** How the core is: taking work, or finishing what it has before it stops. */
export interface Health {
  readonly status: 'ok' | 'stopping';
  readonly version: string;
  /** Whole seconds since the core was made. */
  readonly uptimeSeconds: number;
  /** Pieces of work that have begun and not ended. */
  readonly inFlight: number;
}

/** What a disposal came to. */
export interface Disposal {
  /** True when every piece of work in flight ended before the time ran out. */
  readonly finished: boolean;
  /** How many pieces of work were still going when the wait ended. */
  readonly abandoned: number;
}

/** Work was offered to a core that is stopping or has stopped. */
export class CoreStoppingError extends Error {
  override readonly name = 'CoreStoppingError';
  constructor() {
    super('The server is stopping and takes no new work.');
  }
}

/** The PACS a core has: where instances are kept, what is known of them, and the way in. */
export interface Pacs {
  readonly store: DicomStore;
  readonly index: PacsIndex;
  /**
   * Ingest through the core: each call is work the core counts, so a
   * shutdown waits for it, and it is refused once the core is stopping.
   */
  readonly ingest: Ingest;
}

export interface CoreOptions {
  readonly logger?: Logger;
  /**
   * A store and an index for the core to run a PACS on. The core closes the
   * index when it is disposed. Without them the core has no PACS.
   */
  readonly pacs?: { readonly store: DicomStore; readonly index: PacsIndex };
  /** A job manager for the core to have. The core shuts it down when it is disposed. */
  readonly jobs?: JobManager;
  /** Milliseconds on a clock that only goes forward, for tests. */
  readonly now?: () => number;
}

/**
 * The server without the network: what the store, the index, ingest and jobs
 * will hang from (#42 to #45, #58). It opens no port and reads no environment,
 * so the same core runs behind the HTTP host and inside the desktop
 * application's main process.
 *
 * It keeps count of the work it was given, so that stopping can wait for that
 * work to end.
 */
export interface ServerCore {
  /** Null for a core that was given no store and index. */
  readonly pacs: Pacs | null;
  /** Null for a core that was given no job manager. */
  readonly jobs: JobManager | null;
  health(): Health;
  /**
   * Do a piece of work that a shutdown must wait for. Refused with
   * {@link CoreStoppingError} once the core is stopping.
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Stop: take no new work, wait for the work in flight to end, for at most
   * `timeoutMs` (without one, for as long as it takes). Asking again gives
   * the first answer.
   */
  dispose(options?: { readonly timeoutMs?: number }): Promise<Disposal>;
}

export function createCore(options: CoreOptions = {}): ServerCore {
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let inFlight = 0;
  let disposal: Promise<Disposal> | null = null;
  /** Called each time a piece of work ends while a disposal is waiting. */
  let onSettled: (() => void) | null = null;

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (disposal) throw new CoreStoppingError();
    inFlight++;
    try {
      return await work();
    } finally {
      inFlight--;
      onSettled?.();
    }
  };

  let pacs: Pacs | null = null;
  if (options.pacs) {
    const { store, index } = options.pacs;
    const ingest = createIngest({ store, index, logger });
    pacs = {
      store,
      index,
      ingest: {
        ingest: (bytes, ingestOptions) => run(() => ingest.ingest(bytes, ingestOptions)),
        importFolder: (directory, importOptions) =>
          run(() => ingest.importFolder(directory, importOptions)),
      },
    };
  }

  const jobs = options.jobs ?? null;

  return {
    pacs,
    jobs,
    health: () => ({
      status: disposal ? 'stopping' : 'ok',
      version: SERVER_VERSION,
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      inFlight,
    }),

    run,

    dispose({ timeoutMs } = {}) {
      disposal ??= new Promise<Disposal>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const end = (): void => {
          clearTimeout(timer);
          onSettled = null;
          const result = { finished: inFlight === 0, abandoned: inFlight };
          if (!result.finished) logger.warn('work-abandoned', { count: result.abandoned });
          // Workers are stopped, and the index is closed, once nothing is using
          // them or the wait is over.
          void (async () => {
            await jobs?.shutdown();
            await pacs?.index.close();
          })()
            .catch((error: unknown) => logger.error('core-close-failed', errorFields(error)))
            .then(() => resolve(result));
        };
        if (inFlight === 0) return end();
        logger.info('waiting-for-work', { count: inFlight });
        onSettled = () => {
          if (inFlight === 0) end();
        };
        if (timeoutMs !== undefined) timer = setTimeout(end, timeoutMs);
      });
      return disposal;
    },
  };
}
