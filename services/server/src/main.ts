/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server as a process: configuration from the environment, logs on
// standard output, and a clean stop on SIGTERM or SIGINT.

import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { createLogger, errorFields } from './logger.js';
import { startServer } from './server.js';

let config: ServerConfig;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const logger = createLogger({ level: config.logLevel });

try {
  const server = await startServer(config, logger);
  const stop = (signal: string): void => {
    logger.info('stopping', { signal });
    // Nothing is left running after a clean stop, so the process ends by
    // itself; the exit code says whether anything had to be cut off.
    void server.stop().then((clean) => {
      process.exitCode = clean ? 0 : 1;
    });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
} catch (error) {
  logger.error('start-failed', errorFields(error));
  process.exitCode = 1;
}
