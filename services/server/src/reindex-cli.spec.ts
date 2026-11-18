/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `reindex` command (#328), on a data directory as a server leaves it.
// What needs a PostgreSQL runs where there is one
// (`pacs-index/postgres-testing.ts`).

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import { openSqliteAuditStore } from './audit/audit-store.js';
import { createAuditLog, type AuditLog } from './audit/audit.js';
import { DEFAULT_CONFIG, type ServerConfig } from './config.js';
import { createIngest } from './ingest/ingest.js';
import { createLogger, SILENT_LOGGER } from './logger.js';
import { openPostgresIndex } from './pacs-index/postgres-index.js';
import { POSTGRES, testSchemas, type TestSchemas } from './pacs-index/postgres-testing.js';
import { openSqliteIndex } from './pacs-index/sqlite-index.js';
import { BESIDE, REINDEX_USAGE, runReindexCommand, type ReindexParts } from './reindex-cli.js';
import { SQLITE_INDEX_FILE, STORE_DIRECTORY } from './server.js';
import { openFileStore } from './store/file-store.js';

const COURSE = SYNTHETIC_RT_COURSE;
const FILES = syntheticRtCourse();
const BASELINE = { id: 't1', name: 'Baseline of Zennor', studyUids: [COURSE.planningStudy] };

let dataDir: string;
let audit: AuditLog;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'open-rt-studio-reindex-'));
  audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
});
afterEach(async () => {
  audit.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

const configured = (more: Partial<ServerConfig> = {}): ServerConfig => ({
  ...DEFAULT_CONFIG,
  dataDir,
  ...more,
});

/** The data directory as a server with its index in SQLite leaves it, with a timepoint a user made. */
async function served(): Promise<void> {
  const store = await openFileStore(join(dataDir, STORE_DIRECTORY));
  const index = await openSqliteIndex(join(dataDir, SQLITE_INDEX_FILE));
  const ingest = createIngest({ store, index });
  for (const file of FILES) await ingest.ingest(file.bytes);
  const { patientKey } = (await index.getStudy(COURSE.planningStudy))!;
  await index.putTimepoints(patientKey, [BASELINE]);
  await index.close();
}

interface Ran {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function reindex(
  config: ServerConfig,
  args: readonly string[] = [],
  parts: Partial<ReindexParts> = {},
): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReindexCommand(
    args,
    config,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    {
      serverRuns: async () => false,
      logger: SILENT_LOGGER,
      audit,
      osUser: 'operator-of-the-machine',
      ...parts,
    },
  );
  return { code, out, err };
}

const filled = (): unknown[] => audit.find({ action: 'index-fill' }).items;

describe('the reindex command', () => {
  it('makes an index that was lost again from the store, and says what it did in counts', async () => {
    await served();
    await rm(join(dataDir, SQLITE_INDEX_FILE));
    const before = await readdir(join(dataDir, STORE_DIRECTORY), { recursive: true });

    const ran = await reindex(configured(), [], { progressEvery: 4 });
    expect(ran).toEqual({
      code: 0,
      out: [
        'Filling the index in SQLite from the store.',
        '4 instances read.',
        '8 instances read.',
        `The store holds ${FILES.length} instances. Filed in the index: ${FILES.length} that it did not have, 0 that it had.`,
        'Timepoints, which users make, are kept in the index and in no file: none were brought. (They are brought only from the SQLite index of a data directory into PostgreSQL.)',
      ],
      err: [],
    });
    // Nothing of whose instances they are is said.
    expect(ran.out.join('\n')).not.toContain(SYNTHETIC_PATIENT.id);

    const index = await openSqliteIndex(join(dataDir, SQLITE_INDEX_FILE));
    expect(await index.counts()).toMatchObject({
      patients: 1,
      studies: 2,
      instances: FILES.length,
    });
    expect((await index.relatedToSeries(COURSE.ct))?.structureSets).toHaveLength(1);
    await index.close();
    // The store was read, and is as it was.
    expect(await readdir(join(dataDir, STORE_DIRECTORY), { recursive: true })).toEqual(before);
    expect(filled()).toMatchObject([
      {
        actor: null,
        origin: 'command',
        outcome: 'ok',
        object: 'sqlite',
        patientId: null,
        detail: `instances=${FILES.length} added=${FILES.length} updated=0 unreadable=0 conflicts=0 os-user=operator-of-the-machine`,
      },
    ]);
  });

  it('is refused beside a running server unless it is told to go on', async () => {
    await served();
    await rm(join(dataDir, SQLITE_INDEX_FILE));
    const refused = await reindex(configured(), [], { serverRuns: async () => true });
    expect(refused.code).toBe(1);
    expect(refused.out).toEqual([]);
    expect(refused.err).toEqual([
      `A server with this configuration is running. Stop it first, or say ${BESIDE}: an instance that is deleted through the server while this runs may be listed again.`,
    ]);
    // Nothing was opened, made or recorded.
    expect(existsSync(join(dataDir, SQLITE_INDEX_FILE))).toBe(false);
    expect(filled()).toEqual([]);

    const told = await reindex(configured(), [BESIDE], { serverRuns: async () => true });
    expect(told.code).toBe(0);
    expect(existsSync(join(dataDir, SQLITE_INDEX_FILE))).toBe(true);
  });

  it('ends with 1 when some of the store could not be filed, and says how many', async () => {
    await served();
    const store = await openFileStore(join(dataDir, STORE_DIRECTORY));
    await store.put('1.2.826.0.1.3680043.999.1', new TextEncoder().encode('not DICOM at all'));
    const ran = await reindex(configured());
    expect(ran.code).toBe(1);
    expect(ran.out).toContain(
      'Left out: 1 that could not be read as the DICOM object the store says it is.',
    );
    expect(ran.out).toContain(
      `The store holds ${FILES.length + 1} instances. Filed in the index: 0 that it did not have, ${FILES.length} that it had.`,
    );
    expect(filled()).toMatchObject([{ outcome: 'failed' }]);
  });

  it('says how it is used when it is not understood, and what it lacks when it lacks it', async () => {
    await served();
    expect(await reindex(configured(), ['--everything'])).toEqual({
      code: 2,
      out: [],
      err: [REINDEX_USAGE],
    });
    expect(await reindex(configured({ dataDir: null }))).toEqual({
      code: 2,
      out: [],
      err: ['The store is in the data directory: set OPEN_RT_STUDIO_DATA_DIR.'],
    });
    // A directory with no store in it: nothing is made there.
    const empty = join(dataDir, 'empty');
    expect(await reindex(configured({ dataDir: empty }))).toEqual({
      code: 1,
      out: [],
      err: [
        'There is no store in the data directory to fill an index from. There is no store in the directory.',
      ],
    });
    expect(existsSync(empty)).toBe(false);
    expect(filled()).toEqual([]);
  });

  it('says which setting to look at for a database it cannot reach, and not what the setting holds', async () => {
    await served();
    const lines: string[] = [];
    const ran = await reindex(
      configured({ databaseUrl: 'postgresql://someone:a-password-nobody-may-see@127.0.0.1:1/x' }),
      [],
      { logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }) },
    );
    expect(ran.code).toBe(2);
    expect(ran.err).toHaveLength(1);
    expect(ran.err[0]).toContain('OPEN_RT_STUDIO_DATABASE_URL names (ECONNREFUSED)');
    expect([...ran.err, ...ran.out, ...lines].join('\n')).not.toContain('a-password-nobody');
  });
});

describe.runIf(POSTGRES)('the reindex command, against PostgreSQL', () => {
  let schemas: TestSchemas;
  beforeAll(() => {
    schemas = testSchemas();
  });
  afterAll(async () => {
    await schemas?.drop();
  });

  it('moves a server to PostgreSQL with what it holds, timepoints and all, and can be run again', async () => {
    await served();
    const databaseUrl = await schemas.fresh();

    const ran = await reindex(configured({ databaseUrl }));
    expect(ran).toEqual({
      code: 0,
      out: [
        'Filling the index in PostgreSQL from the store.',
        `The store holds ${FILES.length} instances. Filed in the index: ${FILES.length} that it did not have, 0 that it had.`,
        'Timepoints of 1 patient are in the index in SQLite of the data directory: brought for 1.',
      ],
      err: [],
    });
    expect(filled()).toMatchObject([{ outcome: 'ok', object: 'postgresql' }]);

    const there = await openPostgresIndex(databaseUrl);
    const here = await openSqliteIndex(join(dataDir, SQLITE_INDEX_FILE));
    try {
      expect(await there.counts()).toEqual(await here.counts());
      expect(await there.findSeries()).toEqual(await here.findSeries());
      expect(await there.relatedToSeries(COURSE.ct)).toEqual(await here.relatedToSeries(COURSE.ct));
      const { patientKey } = (await there.getStudy(COURSE.planningStudy))!;
      expect(await there.getTimepoints(patientKey)).toEqual([BASELINE]);

      // Someone makes another timepoint on the new server; the command is run again.
      const later = { id: 't2', name: 'Later', studyUids: [COURSE.followUpStudy] };
      await there.putTimepoints(patientKey, [BASELINE, later]);
      const again = await reindex(configured({ databaseUrl }));
      expect(again.code).toBe(0);
      expect(again.out.slice(1)).toEqual([
        `The store holds ${FILES.length} instances. Filed in the index: 0 that it did not have, ${FILES.length} that it had.`,
        'Timepoints of 1 patient are in the index in SQLite of the data directory: brought for 0.',
        '1 had timepoints in this index already, which were left as they are.',
      ]);
      expect(await there.getTimepoints(patientKey)).toEqual([BASELINE, later]);
    } finally {
      await there.close();
      await here.close();
    }
  });
});
