/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server as a process: configuration from the environment, logs on
// standard output, and a clean stop on SIGTERM or SIGINT. With `account` as
// its first argument it is the command that makes and changes accounts.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAccountCommand, terminalPasswords } from './account-cli.js';
import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts } from './accounts/accounts.js';
import { ConfigError, ENVIRONMENT_VARIABLES, loadConfig, type ServerConfig } from './config.js';
import { createLogger, errorFields } from './logger.js';
import { ACCOUNTS_FILE, startServer } from './server.js';

let config: ServerConfig;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

if (process.argv[2] === 'account') {
  // The accounts of the data directory, whether a server has it open or not.
  if (config.dataDir === null) {
    process.stderr.write(
      `Accounts are kept in the data directory: set ${ENVIRONMENT_VARIABLES.dataDir}.\n`,
    );
    process.exit(2);
  }
  mkdirSync(config.dataDir, { recursive: true });
  const accounts = createAccounts({
    store: openSqliteAccountStore(join(config.dataDir, ACCOUNTS_FILE)),
  });
  let code = 1;
  try {
    code = await runAccountCommand(process.argv.slice(3), accounts, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      ...terminalPasswords(),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    accounts.close();
  }
  process.exit(code);
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
  if (error instanceof ConfigError) {
    // Not a failure of the server: a configuration it will not run with.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    logger.error('start-failed', errorFields(error));
    process.exitCode = 1;
  }
}
