/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { apiRoutes } from './api/api-routes.js';
import type { ServerConfig } from './config.js';
import { createCore, type ServerCore } from './core/core.js';
import { createHost, type HostAddress } from './host/host.js';
import { healthRoute } from './host/routes.js';
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

/** Open the PACS, make a core on it, put the HTTP host in front and listen. */
export async function startServer(config: ServerConfig, logger: Logger): Promise<RunningServer> {
  const core = createCore({ logger, pacs: await openPacs(config, logger) });
  const routes = apiRoutes(core.pacs!, {
    maxUploadBytes: config.maxUploadBytes,
    described: [healthRoute(core)],
  });
  const host = createHost(core, { ...config, logger, routes });
  let address: HostAddress;
  try {
    address = await host.listen();
  } catch (error) {
    // Nothing is left open by a server that could not start.
    await core.dispose();
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
        const clean = closure.finished && disposal.finished;
        logger.info('stopped', { clean });
        return clean;
      })();
      return stopped;
    },
  };
}
