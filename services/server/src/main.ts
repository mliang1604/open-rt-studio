/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server as a process: configuration from the environment, logs on
// standard output, and a clean stop on SIGTERM or SIGINT. With `account` as
// its first argument it is the command that makes and changes accounts; with
// `health`, the one that asks the running server whether it is well.

import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { runAccountCommand, terminalPasswords } from './account-cli.js';
import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts } from './accounts/accounts.js';
import { ConfigError, ENVIRONMENT_VARIABLES, loadConfig, type ServerConfig } from './config.js';
import { askHealth } from './health-check.js';
import { createLogger, errorFields } from './logger.js';
import { ACCOUNTS_FILE, openAudit, startServer } from './server.js';

let config: ServerConfig;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

if (process.argv[2] === 'health') {
  // For a container runtime or a supervisor: 0 when the server with this
  // configuration answers on this machine, 1 when it does not.
  process.exit((await askHealth(config)) ? 0 : 1);
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
  // What the command does to the accounts goes to the audit log the server writes to.
  const audit = openAudit(config.dataDir);
  let osUser: string | null = null;
  try {
    osUser = userInfo().username;
  } catch {
    // A machine that cannot say who its user is: the record says so by saying nothing.
  }
  let code = 1;
  try {
    code = await runAccountCommand(
      process.argv.slice(3),
      accounts,
      {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        ...terminalPasswords(),
      },
      audit ? { log: audit, osUser } : undefined,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    accounts.close();
    audit?.close();
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
