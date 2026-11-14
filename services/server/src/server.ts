/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiRoutes } from './api/api-routes.js';
import { jobRoutes } from './api/job-routes.js';
import type { ServerConfig } from './config.js';
import { createCore, type ServerCore } from './core/core.js';
import { createHost, type HostAddress } from './host/host.js';
import { healthRoute } from './host/routes.js';
import { createJobManager } from './jobs/job-manager.js';
import { openSqliteJobStore } from './jobs/job-store.js';
import type { JobKind } from './jobs/job.js';
import type { Logger } from './logger.js';
import { openSqliteIndex } from './pacs-index/sqlite-index.js';
import { openFileStore } from './store/file-store.js';
import { createMemoryStore } from './store/memory-store.js';

/** A server that is listening. */
export interface RunningServer {
  readonly core: ServerCore;
  readonly address: HostAddress;
  /**
   * Stop cleanly: no new connections, the requests in flight answered, then
   * the core's work finished. True when nothing had to be cut off or
   * abandoned. Asking again gives the first answer.
   */
  stop(): Promise<boolean>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The store and the index the configuration asks for: on disk, or in memory. */
async function openPacs(config: ServerConfig, logger: Logger) {
  if (config.dataDir === null) {
    // Nothing is kept: what is uploaded is gone when the server stops.
    logger.warn('pacs-in-memory');
    return { store: createMemoryStore(), index: await openSqliteIndex(':memory:', { logger }) };
  }
  await mkdir(config.dataDir, { recursive: true });
  const store = await openFileStore(join(config.dataDir, 'store'), { logger });
  const index = await openSqliteIndex(join(config.dataDir, 'index.sqlite'), { logger });
  return { store, index };
}

/** What an embedder or a test adds to a server. */
export interface ServerParts {
  /**
   * The kinds of job the server runs. None by default: the registration and
   * resampling tools register theirs when they exist (M3).
   */
  readonly jobKinds?: readonly JobKind[];
}

/** The job manager the configuration asks for, and how to clear up after it. */
async function openJobs(config: ServerConfig, logger: Logger, kinds: readonly JobKind[]) {
  // Without a data directory, jobs work in a temporary one that goes when the server stops.
  const temporary =
    config.dataDir === null ? await mkdtemp(join(tmpdir(), 'open-rt-studio-jobs-')) : null;
  const jobs = await createJobManager({
    kinds,
    store: openSqliteJobStore(
      config.dataDir === null ? ':memory:' : join(config.dataDir, 'jobs.sqlite'),
    ),
    workRoot: temporary ?? join(config.dataDir!, 'jobs'),
    concurrency: config.jobConcurrency,
    logger,
  });
  const clear = async (): Promise<void> => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  };
  return { jobs, clear };
}

/** Open the PACS and the jobs, make a core on them, put the HTTP host in front and listen. */
export async function startServer(
  config: ServerConfig,
  logger: Logger,
  parts: ServerParts = {},
): Promise<RunningServer> {
  const pacs = await openPacs(config, logger);
  const { jobs, clear } = await openJobs(config, logger, parts.jobKinds ?? []);
  const core = createCore({ logger, pacs, jobs });
  const jobApi = jobRoutes(jobs);
  const routes = [
    ...jobApi,
    ...apiRoutes(core.pacs!, {
      maxUploadBytes: config.maxUploadBytes,
      described: [healthRoute(core), ...jobApi],
    }),
  ];
  const host = createHost(core, { ...config, logger, routes });
  let address: HostAddress;
  try {
    address = await host.listen();
  } catch (error) {
    // Nothing is left open by a server that could not start.
    await core.dispose();
    await clear();
    throw error;
  }
  logger.info('listening', { host: address.host, port: address.port });
  if (!LOOPBACK.has(config.host)) {
    // There are no accounts yet (#55): whoever can reach the port can use it.
    logger.warn('reachable-without-login', { host: address.host });
  }

  let stopped: Promise<boolean> | null = null;
  return {
    core,
    address,
    stop() {
      stopped ??= (async () => {
        const closure = await host.close();
        const disposal = await core.dispose({ timeoutMs: config.shutdownTimeoutMs });
        await clear();
        const clean = closure.finished && disposal.finished;
        logger.info('stopped', { clean });
        return clean;
      })();
      return stopped;
    },
  };
}
