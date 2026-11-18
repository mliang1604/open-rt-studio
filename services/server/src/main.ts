/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server as a process: configuration from the environment, logs on
// standard output, and a clean stop on SIGTERM or SIGINT. With `account` as
// its first argument it is the command that makes and changes accounts; with
// `health`, the one that asks the running server whether it is well; with
// `dicom-echo`, the one that asks another DICOM system whether it is there.

import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { runAccountCommand, terminalPasswords } from './account-cli.js';
import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts } from './accounts/accounts.js';
import { ConfigError, ENVIRONMENT_VARIABLES, loadConfig, type ServerConfig } from './config.js';
import { openFileSettingsStore } from './dimse/dicom-settings.js';
import { isAeTitle } from './dimse/sop-classes.js';
import { clientTls, type ClientTls } from './dimse/tls.js';
import { askHealth } from './health-check.js';
import { createLogger, errorFields } from './logger.js';
import {
  ACCOUNTS_FILE,
  DICOM_SETTINGS_FILE,
  openAudit,
  openDicomTls,
  startServer,
} from './server.js';

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

if (process.argv[2] === 'dicom-echo') {
  // C-ECHO to another system, under this server's AE title: is it there, and
  // does it let this server in? 0 when it answers, 1 when it does not.
  const given = process.argv.slice(3);
  const withTls = given.includes('--tls');
  const [host, portText = '', calledAeTitle = '', ...more] = given.filter((one) => one !== '--tls');
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  if (!host || port < 1 || port > 65535 || !isAeTitle(calledAeTitle) || more.length > 0) {
    process.stderr.write(
      'Usage: dicom-echo <host> <port> <AE title of the other system> [--tls]\n',
    );
    process.exit(2);
  }
  // The title the server goes by now: what was set while it ran, if anything was.
  const kept =
    config.dataDir === null
      ? null
      : openFileSettingsStore(join(config.dataDir, DICOM_SETTINGS_FILE)).read();
  const ownAeTitle = kept?.local.aeTitle ?? config.dicomAeTitle;
  const { dicomEcho } = await import('./dimse/echo.js');
  // With TLS: what the server would bring to the call, as its configuration has it.
  let tls: { readonly tls?: ClientTls } = {};
  if (withTls) {
    try {
      tls = { tls: clientTls(openDicomTls(config, createLogger({ level: 'silent' }))) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
  }
  const result = await dicomEcho({ host, port, calledAeTitle, callingAeTitle: ownAeTitle, ...tls });
  const where = `${calledAeTitle} at ${host}:${port}`;
  switch (result.outcome) {
    case 'ok':
      process.stdout.write(`${where} answered.\n`);
      break;
    case 'rejected':
      process.stderr.write(
        `${where} refused the association. It may not know this server's AE title, ` +
          `${ownAeTitle}, or may go by another title itself.\n`,
      );
      break;
    case 'unreachable':
      process.stderr.write(`No DICOM system answered at ${host}:${port}.\n`);
      break;
    case 'broken':
      process.stderr.write(
        `${host}:${port} took the connection and gave no answer.` +
          `${withTls ? '' : ' It may expect TLS: try --tls.'}\n`,
      );
      break;
    case 'tls-untrusted':
      process.stderr.write(
        `The certificate of ${where} is not of an authority this server trusts ` +
          `(${ENVIRONMENT_VARIABLES.dicomTlsCa}; without, those the machine knows).\n`,
      );
      break;
    case 'tls-expired':
      process.stderr.write(`The certificate of ${where} has expired, or is not valid yet.\n`);
      break;
    case 'tls-name':
      process.stderr.write(`The certificate of ${where} is for another name than ${host}.\n`);
      break;
    case 'tls-refused':
      process.stderr.write(
        `${where} ended the secure connection as it was made. It may want a certificate ` +
          `of this server's, or not accept the one it has.\n`,
      );
      break;
    case 'tls-failed':
      process.stderr.write(
        `No secure connection could be made to ${host}:${port}. It may not use TLS there.\n`,
      );
      break;
    case 'failed':
      process.stderr.write(
        `${where} answered the echo with status 0x${result.status.toString(16).padStart(4, '0')}.\n`,
      );
      break;
  }
  process.exit(result.outcome === 'ok' ? 0 : 1);
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
