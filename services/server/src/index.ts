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
  CONFIG_FILE_VARIABLE,
  ConfigError,
  DEFAULT_CONFIG,
  ENVIRONMENT_VARIABLES,
  loadConfig,
  resolveConfig,
  type ServerConfig,
} from './config.js';
export {
  createHost,
  type HostAddress,
  type HostClosure,
  type HostOptions,
  type ServerHost,
} from './host/host.js';
export { healthRoute, type Route, type RouteResponse } from './host/routes.js';
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
  type StudyQuery,
  type StudyRecord,
} from './pacs-index/pacs-index.js';
export {
  InvalidEntryError,
  openSqliteIndex,
  type SqliteIndexOptions,
} from './pacs-index/sqlite-index.js';
export { startServer, type RunningServer } from './server.js';
export {
  EmptyInstanceError,
  InstanceNotFoundError,
  InvalidUidError,
  assertUid,
  isUid,
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
