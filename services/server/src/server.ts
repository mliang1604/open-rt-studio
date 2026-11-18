/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts, type Accounts } from './accounts/accounts.js';
import { accountRoutes, openSessionRoute } from './api/account-routes.js';
import { apiRoutes } from './api/api-routes.js';
import { auditRoutes } from './api/audit-routes.js';
import { jobRoutes } from './api/job-routes.js';
import { timepointRoutes } from './api/timepoint-routes.js';
import { openSqliteAuditStore } from './audit/audit-store.js';
import { createAuditLog, type AuditLog } from './audit/audit.js';
import { ConfigError, DEFAULT_CONFIG, ENVIRONMENT_VARIABLES, type ServerConfig } from './config.js';
import { CoreStoppingError, createCore, type Pacs, type ServerCore } from './core/core.js';
import { createDispatcher } from './host/dispatch.js';
import { createHost, type HostAddress } from './host/host.js';
import { healthRoute, HttpError, type Route, type RouteResponse } from './host/routes.js';
import { createJobManager } from './jobs/job-manager.js';
import { openSqliteJobStore } from './jobs/job-store.js';
import { dicomRoutes } from './api/dicom-routes.js';
import { dicomAudit } from './dimse/dicom-audit.js';
import type { DicomTls } from './dimse/tls.js';
import { createDicomService, type DicomService } from './dimse/dicom-service.js';
import {
  createMemorySettingsStore,
  newRemoteId,
  openFileSettingsStore,
  type DicomSettings,
} from './dimse/dicom-settings.js';
import type { JobKind } from './jobs/job.js';
import { errorFields, type LogFields, type Logger } from './logger.js';
import { IndexVersionError } from './pacs-index/migrations.js';
import { IndexDatabaseError, type PacsIndex } from './pacs-index/pacs-index.js';
import { openSqliteIndex } from './pacs-index/sqlite-index.js';
import { registrationRoutes } from './api/registration-routes.js';
import {
  DEFORMABLE_REGISTRATION_TOOL,
  deformableRegistrationKind,
} from './registration/deformable-registration.js';
import { readPresets, type RegistrationPreset } from './registration/presets.js';
import {
  RIGID_REGISTRATION_TOOL,
  rigidRegistrationKind,
} from './registration/rigid-registration.js';
import { openFileStore } from './store/file-store.js';
import { createMemoryStore } from './store/memory-store.js';

/** A server that is listening. */
export interface RunningServer {
  readonly core: ServerCore;
  readonly address: HostAddress;
  /** Whether it speaks HTTPS. */
  readonly tls: boolean;
  /** Where it listens for DICOM associations, or null when it has no DICOM listener. */
  readonly dicom: { readonly host: string; readonly port: number; readonly tls: boolean } | null;
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
  const store = await openFileStore(join(config.dataDir, STORE_DIRECTORY), { logger });
  return { store, index: await openIndex(config, config.dataDir, logger) };
}

/** Where the data directory keeps its instances, and its index when that is in SQLite. */
export const STORE_DIRECTORY = 'store';
export const SQLITE_INDEX_FILE = 'index.sqlite';

/**
 * The index of a server that keeps its data: in the PostgreSQL database the
 * configuration names, or else in a SQLite file of the data directory.
 * Throws {@link ConfigError} for a database that cannot be reached or
 * cannot hold the index.
 */
export async function openIndex(
  config: ServerConfig,
  dataDir: string,
  logger: Logger,
  /** Whoever opens it knows of an index in SQLite beside it, and needs no warning of it. */
  knowsOfSqlite = false,
): Promise<PacsIndex> {
  const sqliteFile = join(dataDir, SQLITE_INDEX_FILE);
  if (config.databaseUrl === null) return openSqliteIndex(sqliteFile, { logger });
  // An index that was kept here before is not read, and not moved either.
  if (!knowsOfSqlite && existsSync(sqliteFile)) logger.warn('index-in-sqlite-not-used');
  // Loaded only by a server that is told to use it: one without does not
  // need node-postgres to be there.
  const { openPostgresIndex } = await import('./pacs-index/postgres-index.js');
  try {
    return await openPostgresIndex(config.databaseUrl, { logger });
  } catch (error) {
    if (error instanceof IndexVersionError) {
      // The message is the index's own, and says nothing of the address.
      throw new ConfigError(
        `The PostgreSQL database that ${ENVIRONMENT_VARIABLES.databaseUrl} names cannot hold ` +
          `the index. ${error.message} Give the index a database, or a schema, of its own.`,
      );
    }
    if (!(error instanceof IndexDatabaseError)) throw error;
    // Only the code: what the database or the network said may quote the address.
    throw new ConfigError(
      `The index could not be opened in the PostgreSQL database that ` +
        `${ENVIRONMENT_VARIABLES.databaseUrl} names (${error.code}). Check the address, the ` +
        `database, the user and the password, and that the database can be reached from here.`,
    );
  }
}

/** What an embedder or a test adds to a server. */
export interface ServerParts {
  /**
   * Kinds of job the server runs, besides those its configuration gives it
   * (`nativeTools`). None by default. As a function, the kinds are given a
   * way to the server's PACS, to ask when a job runs and not before.
   */
  readonly jobKinds?: readonly JobKind[] | ((pacs: () => Pacs) => readonly JobKind[]);
  /**
   * The presets the API lists for deformable registration, in place of those
   * beside the native tools: for a test, whose registration job is one of
   * its `jobKinds`.
   */
  readonly registrationPresets?: readonly RegistrationPreset[];
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

/** A certificate that ends within this many days is warned about at start. */
export const CERTIFICATE_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

/** A file a setting names, read; the error names the setting and never the contents. */
function readNamed(path: string, setting: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`The file ${setting} names could not be read.`);
  }
}

/**
 * A certificate and its key, read from the files two settings name and
 * checked. Throws {@link ConfigError} for what a client would otherwise meet
 * as a failed connection with no reason given: a file that cannot be read
 * or is not what it should be, a key that is not the certificate's, a
 * certificate whose time has not come or has passed. The error names the
 * setting, never the file's contents.
 */
function readCertificate(
  files: { readonly cert: string; readonly key: string },
  settings: { readonly cert: string; readonly key: string },
  logger: Logger,
  now: () => number,
  /** What the certificate is for, in the log's word for one that ends soon. */
  use: 'https' | 'dicom',
): { readonly cert: string; readonly key: string } {
  const cert = readNamed(files.cert, settings.cert);
  const key = readNamed(files.key, settings.key);
  let certificate: X509Certificate;
  try {
    // The first in the file is the server's own; any after it lead to its authority.
    certificate = new X509Certificate(cert);
  } catch {
    throw new ConfigError(`The file ${settings.cert} names is not a certificate in PEM.`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key);
  } catch {
    throw new ConfigError(
      `The file ${settings.key} names is not a private key in PEM, ` +
        'or is protected by a passphrase, which the server does not take.',
    );
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new ConfigError(
      use === 'https'
        ? 'The certificate and the key do not belong together.'
        : 'The certificate and the key for DICOM do not belong together.',
    );
  }
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const which = use === 'https' ? 'The certificate' : 'The certificate for DICOM';
  if (now() < from) throw new ConfigError(`${which} is not valid until ${day(from)}.`);
  if (now() > to) throw new ConfigError(`${which} expired on ${day(to)}.`);
  const daysLeft = Math.floor((to - now()) / DAY_MS);
  if (daysLeft < CERTIFICATE_WARNING_DAYS) {
    // The server reads the certificate when it starts: a new one needs a restart.
    logger.warn('certificate-expires-soon', {
      days: daysLeft,
      ...(use === 'https' ? {} : { use }),
    });
  }
  return { cert, key };
}

/**
 * The certificate and key the configuration names for HTTPS, read and
 * checked; null for a server that speaks HTTP.
 */
export function openTls(
  config: ServerConfig,
  logger: Logger,
  now: () => number = Date.now,
): { readonly cert: string; readonly key: string } | null {
  if (config.tlsCert === null || config.tlsKey === null) return null;
  return readCertificate(
    { cert: config.tlsCert, key: config.tlsKey },
    { cert: ENVIRONMENT_VARIABLES.tlsCert, key: ENVIRONMENT_VARIABLES.tlsKey },
    logger,
    now,
    'https',
  );
}

/**
 * What the configuration gives the server for TLS over DICOM (#57): its
 * certificate and key, and the authorities it trusts other systems by.
 * Null for a server that was given no certificate, which can then neither
 * listen with TLS nor show who it is. Throws {@link ConfigError} as
 * {@link openTls} does, and for authorities named without a certificate.
 */
export function openDicomTls(
  config: ServerConfig,
  logger: Logger,
  now: () => number = Date.now,
): DicomTls | null {
  if (config.dicomTlsCert === null || config.dicomTlsKey === null) {
    if (config.dicomTlsCa !== null) {
      throw new ConfigError(
        `${ENVIRONMENT_VARIABLES.dicomTlsCa} names authorities for TLS over DICOM, and the ` +
          `server has no certificate of its own for it: set ` +
          `${ENVIRONMENT_VARIABLES.dicomTlsCert} and ${ENVIRONMENT_VARIABLES.dicomTlsKey} too.`,
      );
    }
    return null;
  }
  const own = readCertificate(
    { cert: config.dicomTlsCert, key: config.dicomTlsKey },
    { cert: ENVIRONMENT_VARIABLES.dicomTlsCert, key: ENVIRONMENT_VARIABLES.dicomTlsKey },
    logger,
    now,
    'dicom',
  );
  if (config.dicomTlsCa === null) return { ...own, ca: null };
  const ca = readNamed(config.dicomTlsCa, ENVIRONMENT_VARIABLES.dicomTlsCa);
  // Each certificate in the file must be one: a file of something else would trust no one.
  const blocks = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  try {
    if (blocks.length === 0) throw new Error('none');
    for (const block of blocks) new X509Certificate(block);
  } catch {
    throw new ConfigError(
      `The file ${ENVIRONMENT_VARIABLES.dicomTlsCa} names is not certificates in PEM.`,
    );
  }
  return { ...own, ca };
}

/** The name of the file in the data directory that holds the audit log. */
export const AUDIT_FILE = 'audit.sqlite';

/** The file in the data directory that keeps the DICOM settings changed while the server ran. */
export const DICOM_SETTINGS_FILE = 'dicom.json';

/** The port offered for a listener that was never given one. */
const USUAL_DICOM_PORT = 11112;

/**
 * The DICOM settings of a server that has kept none: what its configuration
 * says. The calling AE titles of the configuration are systems that only
 * call, and may store.
 */
export function dicomDefaults(config: ServerConfig): DicomSettings {
  return {
    local: {
      enabled: config.dicomPort !== null,
      port: config.dicomPort ?? USUAL_DICOM_PORT,
      aeTitle: config.dicomAeTitle,
      // With a certificate for it, the listener speaks TLS unless it is told not to.
      tls: config.dicomTlsCert !== null,
    },
    remotes: config.dicomCallers.map((aeTitle) => ({
      id: newRemoteId(),
      name: aeTitle,
      aeTitle,
      host: null,
      port: null,
      mayStore: true,
      mayRetrieve: false,
      tls: false,
    })),
  };
}

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

/**
 * What a server warns of as it starts, as events for its log: each a way it
 * is more open, or less use, than it might be meant to be.
 */
export function startWarnings(
  config: ServerConfig,
  state: {
    /** How many accounts there are; null on a server without a login. */
    readonly accounts: number | null;
    readonly tls: boolean;
  },
): { readonly event: string; readonly fields?: LogFields }[] {
  const warnings: { event: string; fields?: LogFields }[] = [];
  if (state.accounts === null) {
    // Whoever can reach the port can use the server. Only this machine can.
    warnings.push({ event: 'no-login' });
    if (config.allowedOrigins.length > 0) {
      // And so can the pages of these origins, in a browser on this machine.
      warnings.push({ event: 'origins-allowed', fields: { count: config.allowedOrigins.length } });
    }
  } else if (state.accounts === 0) {
    // No one can log in until an account is made (the `account add` command).
    warnings.push({ event: 'no-accounts' });
  }
  if (!state.tls && !LOOPBACK.has(config.host)) {
    // Passwords and tokens cross the network as they are, unless what stands
    // in front of the server (a reverse proxy) encrypts.
    warnings.push({ event: 'no-tls' });
  }
  return warnings;
}

/** How often a server with a retention period looks for audit records that have outlived it. */
export const AUDIT_CLEARING_INTERVAL_MS = DAY_MS;

/**
 * Keep the audit log's retention period: clear what has outlived it now, and
 * again every day. Gives what stops it. Does nothing, and gives a stop that
 * does nothing, when there is no log or no period.
 */
export function keepAuditRetention(
  audit: AuditLog | null,
  days: number | null,
  logger: Logger,
  now: () => number = Date.now,
): () => void {
  if (audit === null || days === null) return () => undefined;
  const clear = (): void => {
    try {
      const removed = audit.clear(now() - days * DAY_MS, { actor: null, origin: 'server' });
      if (removed > 0) logger.info('audit-cleared', { count: removed, days });
    } catch (error) {
      // The log is whole, only longer than it was meant to be; tomorrow is another try.
      logger.error('audit-clearing-failed', errorFields(error));
    }
  };
  clear();
  const timer = setInterval(clear, AUDIT_CLEARING_INTERVAL_MS);
  // A server that is otherwise done is not kept running for this.
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The jobs that run the native tools, for a server that is told where the
 * tools are. Throws {@link ConfigError} when a tool is not there: a server
 * that offers a job it cannot run is found out at the first job otherwise.
 */
function nativeJobKinds(
  config: ServerConfig,
  pacs: () => Pacs,
  presets: readonly RegistrationPreset[],
): JobKind[] {
  if (config.nativeTools === null) return [];
  const program = (tool: string): [string] => {
    const file = join(config.nativeTools!, tool);
    if (!existsSync(file)) {
      throw new ConfigError(
        `The directory ${ENVIRONMENT_VARIABLES.nativeTools} names holds no ${tool}. ` +
          `Build the native tools (native/README.md) and name the directory they are in.`,
      );
    }
    return [file];
  };
  const rigid = program(RIGID_REGISTRATION_TOOL);
  const deformable = program(DEFORMABLE_REGISTRATION_TOOL);
  if (presets.length === 0) {
    throw new ConfigError(
      `There are no presets for deformable registration beside the directory ` +
        `${ENVIRONMENT_VARIABLES.nativeTools} names: they are expected in ` +
        `"${PRESETS_BESIDE_TOOLS.join('/')}" from it, as the build of the native tools puts them.`,
    );
  }
  return [
    rigidRegistrationKind({ pacs, program: rigid }),
    deformableRegistrationKind({ pacs, program: deformable, presets }),
  ];
}

/** Where the presets of the deformable registration are, from the directory of the tools. */
const PRESETS_BESIDE_TOOLS = ['..', 'presets', 'deformable'] as const;

/** The presets a server has: those a test gave it, or those beside its native tools, or none. */
function presetsOf(config: ServerConfig, parts: ServerParts): readonly RegistrationPreset[] {
  if (parts.registrationPresets) return parts.registrationPresets;
  if (config.nativeTools === null) return [];
  return readPresets(join(config.nativeTools, ...PRESETS_BESIDE_TOOLS));
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

/** A server put together, with nothing in front of it yet. */
interface Assembled {
  readonly core: ServerCore;
  /** Every route of the API, the health endpoint aside. */
  readonly routes: readonly Route[];
  readonly audit: AuditLog | null;
  readonly dicom: DicomService;
  /** Let go of what was opened besides the core and the accounts. */
  close(): Promise<void>;
}

/**
 * Open the PACS, the jobs, the audit log and the DICOM service, make a core
 * on them, and say what the API's routes are. What listens (the HTTP host)
 * or asks without a network (an embedded server) is put in front by the
 * caller.
 */
async function assemble(
  config: ServerConfig,
  logger: Logger,
  parts: ServerParts,
  accounts: Accounts | null,
  dicomTls: DicomTls | null,
): Promise<Assembled> {
  const audit = openAudit(config.dataDir, parts.audit);
  const stopClearing = keepAuditRetention(audit, config.auditRetentionDays, logger);
  const pacs = await openPacs(config, logger);
  // The kinds are named before the core is made, and ask for its PACS when a job runs.
  const presets = presetsOf(config, parts);
  const made: { core: ServerCore | null } = { core: null };
  const ownPacs = (): Pacs => made.core!.pacs!;
  const { jobs, clear } = await openJobs(config, logger, [
    ...(typeof parts.jobKinds === 'function' ? parts.jobKinds(ownPacs) : (parts.jobKinds ?? [])),
    ...nativeJobKinds(config, ownPacs, presets),
  ]);
  const core = createCore({ logger, pacs, jobs });
  made.core = core;
  const jobApi = [...jobRoutes(jobs), ...registrationRoutes(presets)];
  const sessionApi = accounts ? accountRoutes(accounts) : [openSessionRoute()];
  const auditApi = audit ? auditRoutes(audit) : [];
  const timepointApi = timepointRoutes(core.pacs!.index);
  const dicom = createDicomService({
    pacs: core.pacs!,
    host: config.host,
    exposed: !LOOPBACK.has(config.host),
    maxObjectBytes: config.maxUploadBytes,
    store:
      config.dataDir === null
        ? createMemorySettingsStore()
        : openFileSettingsStore(join(config.dataDir, DICOM_SETTINGS_FILE)),
    defaults: dicomDefaults(config),
    closeTimeoutMs: config.shutdownTimeoutMs,
    audit: dicomAudit(audit, logger),
    tls: dicomTls,
    logger,
  });
  const dicomApi = dicomRoutes(dicom, core.pacs!.index);
  const routes = [
    ...sessionApi,
    ...auditApi,
    ...jobApi,
    ...timepointApi,
    ...dicomApi,
    ...apiRoutes(core.pacs!, {
      maxUploadBytes: config.maxUploadBytes,
      described: [
        healthRoute(core),
        ...sessionApi,
        ...auditApi,
        ...jobApi,
        ...timepointApi,
        ...dicomApi,
      ],
      login: accounts !== null,
      audit: audit !== null,
    }),
  ];
  return {
    core,
    routes,
    audit,
    dicom,
    async close() {
      await clear();
      stopClearing();
      audit?.close();
    },
  };
}

/** Open the PACS and the jobs, make a core on them, put the HTTP host in front and listen. */
export async function startServer(
  config: ServerConfig,
  logger: Logger,
  parts: ServerParts = {},
): Promise<RunningServer> {
  // First: a configuration that is refused opens nothing.
  const tls = openTls(config, logger);
  const dicomTls = openDicomTls(config, logger);
  const accounts = openAccounts(config, logger, parts.accounts);
  const assembled = await assemble(config, logger, parts, accounts, dicomTls);
  const { core, routes, audit, dicom } = assembled;
  const host = createHost(core, { ...config, logger, routes, accounts, audit, tls });
  const warnings = startWarnings(config, {
    accounts: accounts ? accounts.list().length : null,
    tls: tls !== null,
  });
  for (const warning of warnings) logger.warn(warning.event, warning.fields);
  let address: HostAddress;
  try {
    address = await host.listen();
  } catch (error) {
    // Nothing is left open by a server that could not start.
    await core.dispose();
    await assembled.close();
    accounts?.close();
    throw error;
  }
  logger.info('listening', { host: address.host, port: address.port, tls: tls !== null });

  try {
    // Opens the DICOM listener, when the settings ask for one.
    await dicom.start();
  } catch (error) {
    await host.close();
    await core.dispose();
    await assembled.close();
    accounts?.close();
    if ((error as { code?: unknown } | null)?.code === 'no-certificate') {
      // Never without TLS where TLS was asked for: it does not start, and says how it would.
      throw new ConfigError(
        `The DICOM settings that were kept say to listen with TLS, and the server has no ` +
          `certificate for DICOM. Set ${ENVIRONMENT_VARIABLES.dicomTlsCert} and ` +
          `${ENVIRONMENT_VARIABLES.dicomTlsKey}, or take "tls" out of the local settings in ` +
          `${DICOM_SETTINGS_FILE} in the data directory.`,
      );
    }
    throw error;
  }

  let stopped: Promise<boolean> | null = null;
  return {
    core,
    address,
    tls: tls !== null,
    get dicom() {
      return dicom.state().listening;
    },
    stop() {
      stopped ??= (async () => {
        const released = await dicom.close();
        const closure = await host.close();
        const disposal = await core.dispose({ timeoutMs: config.shutdownTimeoutMs });
        await assembled.close();
        accounts?.close();
        const clean = released && closure.finished && disposal.finished;
        logger.info('stopped', { clean });
        return clean;
      })();
      return stopped;
    },
  };
}

/** A request to an embedded server: what a request over HTTP says, without the network. */
export interface EmbeddedRequest {
  readonly method: string;
  /** The path, with its query: `/api/v1/studies?limit=10`. */
  readonly path: string;
  /** By their lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

/** Its answer, whole. */
export interface EmbeddedAnswer {
  readonly status: number;
  /** By their lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface EmbeddedOptions {
  /** Where everything is kept. */
  readonly dataDir: string;
  /** The largest object taken in one request, in bytes. The server's default without. */
  readonly maxUploadBytes?: number;
  /** How long stopping waits for work in flight, in milliseconds. The server's default without. */
  readonly shutdownTimeoutMs?: number;
}

/** A server inside another program: the same API, asked without a network. */
export interface EmbeddedServer {
  readonly core: ServerCore;
  /**
   * Ask the API, as a request over HTTP would. Always answers: what goes
   * wrong is a status, as it is over HTTP. `signal` gives up waiting for an
   * answer that is a stream of bytes.
   */
  ask(request: EmbeddedRequest, signal?: AbortSignal): Promise<EmbeddedAnswer>;
  /** Where it listens for DICOM associations, or null: it does not unless its settings say so. */
  readonly dicom: { readonly host: string; readonly port: number; readonly tls: boolean } | null;
  /** Stop cleanly; true when nothing had to be abandoned. Asking again gives the first answer. */
  stop(): Promise<boolean>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * The server without its HTTP host, for a program that embeds it (the
 * desktop application's main process, #64): the PACS in `dataDir`, with the
 * index in SQLite, and the whole API, asked with `ask`. It opens no port for
 * HTTP and has no accounts: whoever runs the program is its one user. Its
 * DICOM listener is off unless its settings, which are changed through the
 * API, say otherwise, and then listens on this machine only.
 */
export async function openEmbeddedServer(
  options: EmbeddedOptions,
  logger: Logger,
  parts: Omit<ServerParts, 'accounts'> = {},
): Promise<EmbeddedServer> {
  const config: ServerConfig = {
    ...DEFAULT_CONFIG,
    auth: 'none',
    dataDir: options.dataDir,
    maxUploadBytes: options.maxUploadBytes ?? DEFAULT_CONFIG.maxUploadBytes,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_CONFIG.shutdownTimeoutMs,
  };
  const assembled = await assemble(config, logger, parts, null, null);
  const { core, dicom } = assembled;
  const dispatcher = createDispatcher({
    routes: [healthRoute(core), ...assembled.routes],
    audit: assembled.audit,
    logger,
  });
  try {
    // Opens the DICOM listener, when the settings that were kept ask for one.
    await dicom.start();
  } catch (error) {
    await core.dispose();
    await assembled.close();
    throw error;
  }

  let stopped: Promise<boolean> | null = null;
  return {
    core,
    get dicom() {
      return dicom.state().listening;
    },

    async ask(request, signal) {
      const began = performance.now();
      const headers: Record<string, string> = { 'cache-control': 'no-store' };
      const answered = (status: number, body: Uint8Array, route: string): EmbeddedAnswer => {
        // The route's own pattern, never the path asked for.
        logger.info('request', {
          method: request.method,
          route,
          status,
          ms: Math.round(performance.now() - began),
        });
        return { status, headers, body };
      };
      const json = (status: number, body: unknown, route: string): EmbeddedAnswer => {
        headers['content-type'] = JSON_TYPE;
        return answered(status, Buffer.from(JSON.stringify(body)), route);
      };
      const internal = (route: string): EmbeddedAnswer =>
        json(500, { error: 'internal', message: 'The server could not answer.' }, route);

      const url = URL.parse(request.path, 'http://embedded');
      if (url === null || url.origin !== 'http://embedded') {
        return json(
          400,
          { error: 'bad-request', message: 'The address could not be read.' },
          'unreadable',
        );
      }
      const { route, answer } = await core
        .run(() =>
          dispatcher.dispatch({
            method: request.method,
            pathname: url.pathname,
            query: url.searchParams,
            header: (name) => request.headers[name],
            async body(maxBytes) {
              const bytes = request.body ?? new Uint8Array(0);
              if (bytes.byteLength > maxBytes) {
                throw new HttpError(
                  413,
                  'too-large',
                  `The body is longer than the ${maxBytes} bytes allowed.`,
                );
              }
              return bytes;
            },
          }),
        )
        .catch((error: unknown) => {
          if (!(error instanceof CoreStoppingError)) throw error;
          return {
            route: 'stopping',
            answer: {
              status: 503,
              body: { error: 'stopping', message: 'The server is stopping.' },
            } as RouteResponse,
          };
        });
      for (const [name, value] of Object.entries(answer.headers ?? {})) {
        headers[name.toLowerCase()] = value;
      }
      try {
        if ('stream' in answer) {
          const pieces: Buffer[] = [];
          const gone = (): void => void answer.stream.destroy(new Error('given up'));
          signal?.addEventListener('abort', gone, { once: true });
          if (signal?.aborted) gone();
          try {
            for await (const piece of answer.stream) pieces.push(piece as Buffer);
          } finally {
            signal?.removeEventListener('abort', gone);
          }
          return answered(answer.status, Buffer.concat(pieces), route);
        }
        if (answer.status === 204) return answered(204, new Uint8Array(0), route);
        return json(answer.status, answer.body, route);
      } catch (error) {
        // What went wrong is for the log; the caller is told only that it did.
        logger.error('response-failed', { route, ...errorFields(error) });
        return internal(route);
      }
    },

    stop() {
      stopped ??= (async () => {
        const released = await dicom.close();
        const disposal = await core.dispose({ timeoutMs: config.shutdownTimeoutMs });
        await assembled.close();
        const clean = released && disposal.finished;
        logger.info('stopped', { clean });
        return clean;
      })();
      return stopped;
    },
  };
}
