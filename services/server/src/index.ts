/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The package's one entry point. An embedder (the desktop application's main
// process) makes a core with createCore; the network service adds the host
// with startServer, which is what `main.ts` does.

export {
  CoreStoppingError,
  createCore,
  type CoreOptions,
  type Disposal,
  type Health,
  type Pacs,
  type ServerCore,
} from './core/core.js';
export {
  AUTH_MODES,
  CONFIG_FILE_VARIABLE,
  ConfigError,
  DEFAULT_CONFIG,
  ENVIRONMENT_VARIABLES,
  loadConfig,
  resolveConfig,
  type AuthMode,
  type ServerConfig,
} from './config.js';
export {
  AccountError,
  createAccounts,
  LOGIN_ATTEMPTS,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  type Account,
  type Accounts,
  type AccountsOptions,
  type LoginResult,
  type Session,
} from './accounts/accounts.js';
export {
  ACCOUNT_MIGRATIONS,
  openSqliteAccountStore,
  ROLES,
  type AccountRecord,
  type AccountStore,
  type Role,
  type SessionRecord,
} from './accounts/account-store.js';
export {
  DEFAULT_PASSWORD_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordCost,
} from './accounts/password.js';
export { accountRoutes, openSessionRoute } from './api/account-routes.js';
export {
  AUDIT_PAGE_MAX,
  AUDIT_RUN_IDLE_MS,
  AUDIT_RUN_MAX_MS,
  createAuditLog,
  type AuditLog,
  type AuditLogOptions,
} from './audit/audit.js';
export {
  AUDIT_ACTIONS,
  AUDIT_MIGRATIONS,
  AUDIT_OUTCOMES,
  openSqliteAuditStore,
  type AuditAction,
  type AuditEntry,
  type AuditOutcome,
  type AuditQuery,
  type AuditRecord,
  type AuditStore,
} from './audit/audit-store.js';
export { auditRoutes } from './api/audit-routes.js';
export {
  createHost,
  type HostAddress,
  type HostClosure,
  type HostOptions,
  type ServerHost,
} from './host/host.js';
export {
  healthRoute,
  HttpError,
  matchPath,
  type ParameterDoc,
  type Route,
  type RouteAccess,
  type RouteDoc,
  type RouteRequest,
  type RouteResponse,
} from './host/routes.js';
export {
  API_PREFIX,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  apiRoutes,
  type ApiOptions,
} from './api/api-routes.js';
export { openApiDocument } from './api/openapi.js';
export { jobRoutes } from './api/job-routes.js';
export { createJobManager, type JobManager, type JobManagerOptions } from './jobs/job-manager.js';
export {
  JOB_MIGRATIONS,
  openSqliteJobStore,
  type JobQuery,
  type JobStore,
} from './jobs/job-store.js';
export {
  InvalidJobInputError,
  JOB_STATUSES,
  JobsStoppedError,
  UnknownJobKindError,
  readWorkerLine,
  type Job,
  type JobCommand,
  type JobFailure,
  type JobKind,
  type JobLogLine,
  type JobStatus,
  type JsonObject,
  type JsonValue,
  type WorkerLine,
} from './jobs/job.js';
export {
  createIngest,
  indexEntry,
  type ImportOptions,
  type ImportProgress,
  type ImportSummary,
  type Ingest,
  type IngestOptions,
  type IngestParts,
  type IngestResult,
  type RefusalReason,
} from './ingest/ingest.js';
export {
  LOG_LEVELS,
  REDACTED,
  SILENT_LOGGER,
  createLogger,
  errorFields,
  identifies,
  type LogFields,
  type LogLevel,
  type LogValue,
  type Logger,
  type LoggerOptions,
} from './logger.js';
export {
  APPLICATION_ID,
  IndexVersionError,
  LATEST_VERSION,
  MIGRATIONS,
  type Migration,
} from './pacs-index/migrations.js';
export {
  IndexConflictError,
  InvalidQueryError,
  RELATIONS,
  type IndexConflict,
  type IndexCounts,
  type InstanceEntry,
  type InstanceQuery,
  type InstanceRecord,
  type PacsIndex,
  type Page,
  type PatientQuery,
  type PatientRecord,
  type Reference,
  type RelatedToSeries,
  type Relation,
  type SeriesQuery,
  type SeriesRecord,
  type StudyOrder,
  type StudyQuery,
  type StudyRecord,
} from './pacs-index/pacs-index.js';
export {
  InvalidEntryError,
  openSqliteIndex,
  type SqliteIndexOptions,
} from './pacs-index/sqlite-index.js';
export { startServer, type RunningServer, type ServerParts } from './server.js';
export {
  EmptyInstanceError,
  InstanceNotFoundError,
  InvalidUidError,
  assertUid,
  isUid,
  type ByteRange,
  type DicomStore,
  type InstanceBytes,
  type StoredInstance,
} from './store/dicom-store.js';
export {
  STORE_LAYOUT,
  STORE_MARKER,
  StoreLayoutError,
  openFileStore,
  type FileStoreOptions,
} from './store/file-store.js';
export { createMemoryStore } from './store/memory-store.js';
export { SERVER_VERSION } from './version.js';
