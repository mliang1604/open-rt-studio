/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts, type Accounts } from './accounts/accounts.js';
import { accountRoutes, openSessionRoute } from './api/account-routes.js';
import { apiRoutes } from './api/api-routes.js';
import { auditRoutes } from './api/audit-routes.js';
import { jobRoutes } from './api/job-routes.js';
import { openSqliteAuditStore } from './audit/audit-store.js';
import { createAuditLog, type AuditLog } from './audit/audit.js';
import { ConfigError, ENVIRONMENT_VARIABLES, type ServerConfig } from './config.js';
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
  /**
   * The accounts of a server whose `auth` is `accounts`, in place of the ones
   * kept in the data directory: for a test, which keeps them in memory. The
   * server closes them when it stops.
   */
  readonly accounts?: Accounts;
  /**
   * The audit log, in place of the one kept in the data directory: for a
   * test, which keeps it in memory. The server closes it when it stops.
   */
  readonly audit?: AuditLog;
}

/** The name of the file in the data directory that holds the accounts and their sessions. */
export const ACCOUNTS_FILE = 'accounts.sqlite';

/**
 * Who may use the server, as the configuration asks: its accounts, or null
 * for a server without a login. Throws {@link ConfigError} for a
 * configuration that would leave the server open to more than this machine,
 * or with accounts and nowhere to keep them.
 */
export function openAccounts(
  config: ServerConfig,
  logger: Logger,
  given?: Accounts,
): Accounts | null {
  if (config.auth === 'none') {
    if (!LOOPBACK.has(config.host)) {
      throw new ConfigError(
        `${ENVIRONMENT_VARIABLES.auth}=none is only for a server that listens on this machine ` +
          `(${ENVIRONMENT_VARIABLES.host}=127.0.0.1). A server others can reach needs accounts.`,
      );
    }
    return null;
  }
  if (given) return given;
  if (config.dataDir === null) {
    throw new ConfigError(
      `Accounts are kept in the data directory: set ${ENVIRONMENT_VARIABLES.dataDir}. ` +
        `To try the server on this machine without a login, set ${ENVIRONMENT_VARIABLES.auth}=none.`,
    );
  }
  mkdirSync(config.dataDir, { recursive: true });
  return createAccounts({
    store: openSqliteAccountStore(join(config.dataDir, ACCOUNTS_FILE)),
    logger,
  });
}

/** The name of the file in the data directory that holds the audit log. */
export const AUDIT_FILE = 'audit.sqlite';

/**
 * Where it is written who did what: in the data directory. Null for a
 * server without one, which keeps nothing, an audit log no more than
 * anything else.
 */
export function openAudit(dataDir: string | null, given?: AuditLog): AuditLog | null {
  if (given) return given;
  if (dataDir === null) return null;
  mkdirSync(dataDir, { recursive: true });
  return createAuditLog({ store: openSqliteAuditStore(join(dataDir, AUDIT_FILE)) });
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
  // First: a configuration that is refused opens nothing.
  const accounts = openAccounts(config, logger, parts.accounts);
  const audit = openAudit(config.dataDir, parts.audit);
  const pacs = await openPacs(config, logger);
  const { jobs, clear } = await openJobs(config, logger, parts.jobKinds ?? []);
  const core = createCore({ logger, pacs, jobs });
  const jobApi = jobRoutes(jobs);
  const sessionApi = accounts ? accountRoutes(accounts) : [openSessionRoute()];
  const auditApi = audit ? auditRoutes(audit) : [];
  const routes = [
    ...sessionApi,
    ...auditApi,
    ...jobApi,
    ...apiRoutes(core.pacs!, {
      maxUploadBytes: config.maxUploadBytes,
      described: [healthRoute(core), ...sessionApi, ...auditApi, ...jobApi],
      login: accounts !== null,
      audit: audit !== null,
    }),
  ];
  const host = createHost(core, { ...config, logger, routes, accounts, audit });
  if (accounts === null) {
    // Whoever can reach the port can use the server. Only this machine can.
    logger.warn('no-login');
    if (config.allowedOrigins.length > 0) {
      // And so can the pages of these origins, in a browser on this machine.
      logger.warn('origins-allowed', { count: config.allowedOrigins.length });
    }
  } else if (accounts.list().length === 0) {
    // No one can log in until an account is made (the `account add` command).
    logger.warn('no-accounts');
  }
  let address: HostAddress;
  try {
    address = await host.listen();
  } catch (error) {
    // Nothing is left open by a server that could not start.
    await core.dispose();
    await clear();
    accounts?.close();
    audit?.close();
    throw error;
  }
  logger.info('listening', { host: address.host, port: address.port });

  let stopped: Promise<boolean> | null = null;
  return {
    core,
    address,
    stop() {
      stopped ??= (async () => {
        const closure = await host.close();
        const disposal = await core.dispose({ timeoutMs: config.shutdownTimeoutMs });
        await clear();
        accounts?.close();
        audit?.close();
        const clean = closure.finished && disposal.finished;
        logger.info('stopped', { clean });
        return clean;
      })();
      return stopped;
    },
  };
}
