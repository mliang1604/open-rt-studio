/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `reindex` command (#328): files every instance of the data
// directory's store in the index the configuration names. For an index that
// was lost, and for moving a server to PostgreSQL with what it holds.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditLog } from './audit/audit.js';
import { ConfigError, ENVIRONMENT_VARIABLES, type ServerConfig } from './config.js';
import {
  copyTimepoints,
  filledWhole,
  fillIndex,
  type FillSummary,
  type TimepointsCopied,
} from './ingest/reindex.js';
import type { Logger } from './logger.js';
import { IndexDatabaseError, type PacsIndex } from './pacs-index/pacs-index.js';
import { openSqliteIndex } from './pacs-index/sqlite-index.js';
import { openIndex, SQLITE_INDEX_FILE, STORE_DIRECTORY } from './server.js';
import { openFileStore, StoreLayoutError } from './store/file-store.js';

export interface ReindexIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ReindexParts {
  /** Whether a server with this configuration answers on this machine. */
  serverRuns(): Promise<boolean>;
  readonly logger: Logger;
  /** Where it is recorded that the index was filled, and by whom; null for none. */
  readonly audit: AuditLog | null;
  readonly osUser: string | null;
  /** How often to say how far it is, in instances. 500 by default. */
  readonly progressEvery?: number;
}

/** The argument that lets the command run beside a server. */
export const BESIDE = '--beside-a-running-server';

export const REINDEX_USAGE = [
  'Usage: reindex [--beside-a-running-server]',
  '',
  'Files every instance the store of the data directory holds in the index the',
  'configuration names: a SQLite file in the data directory, or the PostgreSQL',
  `database of ${ENVIRONMENT_VARIABLES.databaseUrl}. What the index has already is brought`,
  'up to date; nothing is taken out of it. It can be run again.',
  '',
  'Stop the server first. Beside a running server it is refused, unless told',
  `otherwise (${BESIDE}): an instance that is deleted through the server at`,
  'that moment may be listed again.',
].join('\n');

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** What came of it, in sentences: counts, and nothing of what was filed. */
export function fillReport(summary: FillSummary): string[] {
  const lines = [
    `The store holds ${plural(summary.instances, 'instance', 'instances')}. ` +
      `Filed in the index: ${summary.added} that it did not have, ` +
      `${summary.updated} that it had.`,
  ];
  if (summary.unreadable > 0) {
    lines.push(
      `Left out: ${summary.unreadable} that could not be read as the DICOM object the store says ` +
        `it is.`,
    );
  }
  if (summary.conflicts > 0) {
    lines.push(
      `Left out: ${summary.conflicts} that the index has in another series, study or patient.`,
    );
  }
  if (summary.gone > 0) {
    lines.push(`${summary.gone} left the store while this ran, and were passed over.`);
  }
  return lines;
}

export function timepointsReport(copied: TimepointsCopied): string[] {
  if (copied.patients === 0) {
    return ['The index in SQLite of the data directory has no timepoints to bring.'];
  }
  const lines = [
    `Timepoints of ${plural(copied.patients, 'patient', 'patients')} are in the index in SQLite ` +
      `of the data directory: brought for ${copied.copied}.`,
  ];
  if (copied.alreadyThere > 0) {
    lines.push(
      `${copied.alreadyThere} had timepoints in this index already, which were left as they are.`,
    );
  }
  if (copied.withoutPatient > 0) {
    lines.push(`${copied.withoutPatient} are of patients this index does not have.`);
  }
  if (copied.studiesLeftOut > 0) {
    lines.push(
      `${plural(copied.studiesLeftOut, 'study was', 'studies were')} left out of a timepoint: ` +
        `this index does not have them.`,
    );
  }
  return lines;
}

/**
 * Run the command. Returns the exit code: 0 for an index that now lists
 * every instance of the store, 1 when it could not be done or some were
 * left out, 2 when it was not understood or the configuration is refused.
 */
export async function runReindexCommand(
  args: readonly string[],
  config: ServerConfig,
  io: ReindexIo,
  parts: ReindexParts,
): Promise<number> {
  if (args.some((arg) => arg !== BESIDE)) {
    io.err(REINDEX_USAGE);
    return 2;
  }
  if (config.dataDir === null) {
    io.err(`The store is in the data directory: set ${ENVIRONMENT_VARIABLES.dataDir}.`);
    return 2;
  }
  if (!args.includes(BESIDE) && (await parts.serverRuns())) {
    io.err(
      `A server with this configuration is running. Stop it first, or say ${BESIDE}: an ` +
        `instance that is deleted through the server while this runs may be listed again.`,
    );
    return 1;
  }

  const { logger } = parts;
  let store;
  try {
    // To be read: a server that runs beside this may be writing to it.
    store = await openFileStore(join(config.dataDir, STORE_DIRECTORY), { logger, readOnly: true });
  } catch (error) {
    if (!(error instanceof StoreLayoutError)) throw error;
    io.err(`There is no store in the data directory to fill an index from. ${error.message}`);
    return 1;
  }

  const sqliteFile = join(config.dataDir, SQLITE_INDEX_FILE);
  const toPostgres = config.databaseUrl !== null;
  let index: PacsIndex;
  try {
    index = await openIndex(config, config.dataDir, logger, true);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.err(error.message);
    return 2;
  }

  const every = parts.progressEvery ?? 500;
  let summary: FillSummary | null = null;
  let code = 1;
  try {
    io.out(`Filling the index in ${toPostgres ? 'PostgreSQL' : 'SQLite'} from the store.`);
    summary = await fillIndex({
      store,
      index,
      logger,
      onProgress: (soFar) => {
        if (soFar.instances % every === 0) io.out(`${soFar.instances} instances read.`);
      },
    });
    for (const line of fillReport(summary)) io.out(line);

    // What users made and no file holds.
    if (toPostgres && existsSync(sqliteFile)) {
      const old = await openSqliteIndex(sqliteFile, { logger });
      try {
        for (const line of timepointsReport(await copyTimepoints(old, index))) io.out(line);
      } finally {
        await old.close();
      }
    } else {
      io.out(
        'Timepoints, which users make, are kept in the index and in no file: none were ' +
          'brought. (They are brought only from the SQLite index of a data directory into ' +
          'PostgreSQL.)',
      );
    }
    code = filledWhole(summary) ? 0 : 1;
  } catch (error) {
    if (!(error instanceof IndexDatabaseError)) throw error;
    // Its code, and nothing the database said of what it was given.
    io.err(`The index's database failed part-way (${error.code}). Run the command again.`);
  } finally {
    await index.close();
    try {
      parts.audit?.record({
        actor: null,
        origin: 'command',
        action: 'index-fill',
        outcome: code === 0 ? 'ok' : 'failed',
        patientId: null,
        studyUid: null,
        seriesUid: null,
        object: toPostgres ? 'postgresql' : 'sqlite',
        detail:
          [
            summary === null
              ? null
              : `instances=${summary.instances} added=${summary.added} updated=${summary.updated} ` +
                `unreadable=${summary.unreadable} conflicts=${summary.conflicts}`,
            parts.osUser === null ? null : `os-user=${parts.osUser}`,
          ]
            .filter((part) => part !== null)
            .join(' ') || null,
      });
    } catch {
      io.err('This could not be written to the audit log.');
      code = 1;
    }
  }
  return code;
}
