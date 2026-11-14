/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ServerConfig } from './config.js';
import { createCore, type ServerCore } from './core/core.js';
import { createHost, type HostAddress } from './host/host.js';
import type { Logger } from './logger.js';

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

/** Make a core, put the HTTP host in front of it and listen. */
export async function startServer(config: ServerConfig, logger: Logger): Promise<RunningServer> {
  const core = createCore({ logger });
  const host = createHost(core, { ...config, logger });
  const address = await host.listen();
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
