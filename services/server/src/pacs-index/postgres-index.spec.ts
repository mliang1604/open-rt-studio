/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The index in PostgreSQL (#44). What needs a PostgreSQL runs where there is
// one (`postgres-testing.ts`); what does not, runs everywhere.

import { DatabaseSync } from 'node:sqlite';

import { instanceUid, SYNTHETIC_FOLLOW_UP_STUDY, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';

import { createLogger } from '../logger.js';
import { describePacsIndex } from './index-suite.js';
import { IndexVersionError, migrate } from './migrations.js';
import { IndexDatabaseError, type PacsIndex } from './pacs-index.js';
import { openPostgresIndex } from './postgres-index.js';
import {
  MARKER_TABLE,
  migratePostgres,
  POSTGRES_LATEST_VERSION,
  POSTGRES_MIGRATIONS,
} from './postgres-migrations.js';
import { POSTGRES, POSTGRES_REQUIRED, testSchemas, type TestSchemas } from './postgres-testing.js';
import { connect, databaseError } from './postgres.js';
import { entry, SERIES, syntheticRtDataset } from './testing.js';

const PLANNING = SYNTHETIC_STUDY;
const FOLLOW_UP = SYNTHETIC_FOLLOW_UP_STUDY;

/** What a promise was rejected with. */
const thrown = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error('It did not fail.');
    },
    (caught: unknown) => caught as Error,
  );
/** A password that must be in no error and no log. */
const PASSWORD = 'a-password-nobody-may-see';
/** No PostgreSQL is there: port 1 of this machine. */
const NOWHERE = `postgresql://someone:${PASSWORD}@127.0.0.1:1/somewhere`;

describe('what PostgreSQL says of a failure', () => {
  it('is kept as its code, and nothing it quotes', () => {
    const said = Object.assign(new Error('invalid input syntax for type bigint: "SYN-0001"'), {
      code: '22P02',
      detail: 'Key (patient_id, issuer)=(SYN-0001, ) already exists.',
    });
    const kept = databaseError(said);
    expect(kept).toBeInstanceOf(IndexDatabaseError);
    expect(kept.code).toBe('22P02');
    expect(kept.message).toBe("The index's database did not do what it was asked (22P02).");
    expect(JSON.stringify({ ...kept, message: kept.message, stack: kept.stack })).not.toContain(
      'SYN-0001',
    );
  });

  it('is a code of the network for a database that is not reached, and a word for what has none', () => {
    expect(databaseError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code).toBe(
      'ECONNREFUSED',
    );
    expect(databaseError(new Error('timeout exceeded when trying to connect')).code).toBe(
      'TIMEOUT',
    );
    expect(databaseError(new Error('Something about SYN-0001')).code).toBe('UNKNOWN');
    // A code is letters, digits and "_": anything else is not taken for one.
    expect(databaseError({ code: 'SYN-0001 said so' }).code).toBe('UNKNOWN');
    expect(databaseError(null).code).toBe('UNKNOWN');
  });

  it('is not said of a database that is not there, with its address or its password', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
    const refused = openPostgresIndex(NOWHERE, { logger });
    await expect(refused).rejects.toBeInstanceOf(IndexDatabaseError);
    await expect(refused).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    const error = await thrown(refused);
    for (const text of [error.message, error.stack ?? '', ...lines]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('someone');
      expect(text).not.toContain('127.0.0.1');
    }
  });
});

describe('the steps of the schema in PostgreSQL', () => {
  it('are numbered 1, 2, 3, ... and each has a name', () => {
    expect(POSTGRES_MIGRATIONS.map((step) => step.version)).toEqual(
      POSTGRES_MIGRATIONS.map((_, i) => i + 1),
    );
    for (const step of POSTGRES_MIGRATIONS) expect(step.name).not.toBe('');
    expect(POSTGRES_LATEST_VERSION).toBe(POSTGRES_MIGRATIONS.length);
  });
});

it.runIf(POSTGRES_REQUIRED)('has a PostgreSQL to run against, where one is required', () => {
  expect(process.env['OPEN_RT_STUDIO_TEST_POSTGRES'] ?? '').not.toBe('');
});

describe.runIf(POSTGRES)('against PostgreSQL', () => {
  let schemas: TestSchemas;
  const open: PacsIndex[] = [];
  beforeAll(() => {
    schemas = testSchemas();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((index) => index.close()));
  });
  afterAll(async () => {
    await schemas?.drop();
  });

  const opened = async (url: string): Promise<PacsIndex> => {
    const index = await openPostgresIndex(url, { connections: 4 });
    open.push(index);
    return index;
  };
  const tablesOf = async (url: string): Promise<string[]> =>
    (
      await schemas
        .within(url)
        .query(
          'SELECT tablename::text AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1',
        )
    ).map((row) => String(row['name']));

  describe('the index in PostgreSQL', () => {
    describePacsIndex(async () => openPostgresIndex(await schemas.fresh(), { connections: 4 }));
  });

  describe('migrations', () => {
    it('create the tables in an empty schema, and say so', async () => {
      const url = await schemas.fresh();
      const lines: string[] = [];
      const index = await openPostgresIndex(url, {
        logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
      });
      open.push(index);
      expect(JSON.parse(lines[0])).toMatchObject({
        event: 'index-opened',
        backend: 'postgresql',
        schemaFrom: 0,
        schema: POSTGRES_LATEST_VERSION,
      });
      expect(await tablesOf(url)).toEqual(
        [
          'instance',
          MARKER_TABLE,
          'patient',
          'patient_timepoints',
          'reference',
          'series',
          'study',
        ].sort(),
      );
      expect(await index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
    });

    it('give the tables and the columns that the index in SQLite has', async () => {
      const sqlite = new DatabaseSync(':memory:');
      migrate(sqlite);
      const columns = (table: string): string[] =>
        (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
          .map((column) => column.name)
          .sort();
      const tables = (
        sqlite
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
          .all() as {
          name: string;
        }[]
      ).map((row) => row.name);

      const url = await schemas.fresh();
      await opened(url);
      const there = await schemas.within(url).query(
        `SELECT table_name::text AS "table", column_name::text AS "column"
           FROM information_schema.columns WHERE table_schema = current_schema()`,
      );
      const columnsThere = (table: string): string[] =>
        there
          .filter((row) => row['table'] === table)
          .map((row) => String(row['column']))
          .sort();
      expect((await tablesOf(url)).filter((table) => table !== MARKER_TABLE)).toEqual(tables);
      for (const table of tables) expect(columnsThere(table), table).toEqual(columns(table));
      sqlite.close();
    });

    it('do nothing to an index that is up to date, and keep what it holds', async () => {
      const url = await schemas.fresh();
      const first = await openPostgresIndex(url);
      for (const one of syntheticRtDataset()) await first.putInstance(one);
      await first.close();

      const db = schemas.within(url);
      expect(await migratePostgres(db)).toEqual({
        from: POSTGRES_LATEST_VERSION,
        to: POSTGRES_LATEST_VERSION,
      });
      const again = await opened(url);
      expect(await again.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 11 });
      // The latest first.
      expect((await again.findStudies()).map((study) => study.description)).toEqual([
        FOLLOW_UP.description,
        PLANNING.description,
      ]);
    });

    it('apply a step whole or not at all', async () => {
      const url = await schemas.fresh();
      const db = schemas.within(url);
      const broken = [
        POSTGRES_MIGRATIONS[0],
        {
          version: 2,
          name: 'broken',
          sql: 'CREATE TABLE extra (a TEXT); CREATE TABLE patient (a TEXT);',
        },
      ];
      // 42P07: there is a table of that name already.
      await expect(migratePostgres(db, 2, broken)).rejects.toMatchObject({ code: '42P07' });
      // Step 1 stands; nothing of step 2 does.
      expect(await db.query(`SELECT version FROM ${MARKER_TABLE}`)).toEqual([{ version: 1 }]);
      expect(await tablesOf(url)).not.toContain('extra');
      expect(await tablesOf(url)).toContain('patient');
    });

    it('stop at the step that is asked for', async () => {
      const url = await schemas.fresh();
      const db = schemas.within(url);
      const two = [
        POSTGRES_MIGRATIONS[0],
        { version: 2, name: 'one more', sql: 'CREATE TABLE extra (a TEXT)' },
      ];
      expect(await migratePostgres(db, 1, two)).toEqual({ from: 0, to: 1 });
      expect(await tablesOf(url)).not.toContain('extra');
      expect(await migratePostgres(db, 2, two)).toEqual({ from: 1, to: 2 });
      expect(await tablesOf(url)).toContain('extra');
    });

    it('refuse an index made by a newer version', async () => {
      const url = await schemas.fresh();
      await (await openPostgresIndex(url)).close();
      await schemas
        .within(url)
        .query(`UPDATE ${MARKER_TABLE} SET version = $1`, [POSTGRES_LATEST_VERSION + 1]);
      await expect(openPostgresIndex(url)).rejects.toThrow(
        new IndexVersionError(
          `The index was made by a newer version (schema ${POSTGRES_LATEST_VERSION + 1}; this one knows up to ${POSTGRES_LATEST_VERSION}).`,
        ),
      );
    });

    it('refuse a schema that holds something else, and leave it as it is', async () => {
      const url = await schemas.fresh();
      await schemas.within(url).query('CREATE TABLE recipes (name TEXT)');
      await expect(openPostgresIndex(url)).rejects.toBeInstanceOf(IndexVersionError);
      expect(await tablesOf(url)).toEqual(['recipes']);
    });

    it('are applied once when two servers start at the same moment', async () => {
      const url = await schemas.fresh();
      const [one, two] = await Promise.all([opened(url), opened(url)]);
      expect(await one.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
      expect(await two.putInstance(entry(PLANNING, 'CT', SERIES.CT, 1))).toBe('added');
      expect((await one.counts()).instances).toBe(1);
    });
  });

  describe('two servers on one index', () => {
    it('see what each other put, and put at the same time without getting in the way', async () => {
      const url = await schemas.fresh();
      const [one, two] = [await opened(url), await opened(url)];
      const dataset = syntheticRtDataset();
      // One patient, two studies, seven series: each made once, by whichever came first.
      const results = await Promise.all(
        dataset.map((each, n) => (n % 2 === 0 ? one : two).putInstance(each)),
      );
      expect(results).toEqual(dataset.map(() => 'added'));
      for (const index of [one, two]) {
        expect(await index.counts()).toEqual({ patients: 1, studies: 2, series: 7, instances: 11 });
      }
      expect(await two.removeInstance(instanceUid(PLANNING, SERIES.CT, 1))).toBe(true);
      expect(await one.getInstance(instanceUid(PLANNING, SERIES.CT, 1))).toBeNull();
    });
  });

  describe('what cannot be kept', () => {
    it('is refused with the code PostgreSQL gave, and none of what it was given', async () => {
      const index = await opened(await schemas.fresh());
      const one = entry(PLANNING, 'CT', SERIES.CT, 1);
      // A number that is no whole number, which the entry is not checked for.
      const refused = index.putInstance({
        ...one,
        instance: { ...one.instance, number: 'SYN-0001 is no number' as unknown as number },
      });
      await expect(refused).rejects.toBeInstanceOf(IndexDatabaseError);
      await expect(refused).rejects.toMatchObject({ code: '22P02' });
      const error = await thrown(refused);
      expect(`${error.message} ${error.stack}`).not.toContain('SYN-0001');
      // Nothing of the entry was kept, and the index goes on.
      expect(await index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
      expect(await index.putInstance(one)).toBe('added');
    });

    it('keeps a name without the character PostgreSQL has no place for', async () => {
      const index = await opened(await schemas.fresh());
      const one = entry(PLANNING, 'CT', SERIES.CT, 1);
      await index.putInstance({ ...one, patient: { ...one.patient, name: 'NUL\u0000^Inside' } });
      expect((await index.findPatients())[0].name).toBe('NUL^Inside');
    });

    it('refuses a wrong password, and says only that', async () => {
      const url = new URL(await schemas.fresh());
      url.password = PASSWORD;
      const refused = openPostgresIndex(url.href);
      await expect(refused).rejects.toBeInstanceOf(IndexDatabaseError);
      // 28P01: the password is not the user's. (28000 where the database lets no one in that way.)
      await expect(refused).rejects.toMatchObject({ code: expect.stringMatching(/^28/) });
      const error = await thrown(refused);
      expect(`${error.message} ${error.stack}`).not.toContain(PASSWORD);
    });
  });

  describe('the driver', () => {
    it('takes back all of a transaction whose body throws, and gives the connection back', async () => {
      const db = connect(await schemas.fresh(), { connections: 1 });
      await db.query('CREATE TABLE kept (n INTEGER)');
      await expect(
        db.transaction(async (run) => {
          await run.query('INSERT INTO kept VALUES (1)');
          throw new Error('changed my mind');
        }),
      ).rejects.toThrow('changed my mind');
      // The one connection is there to ask with again.
      expect(await db.query('SELECT count(*)::int AS n FROM kept')).toEqual([{ n: 0 }]);
      await db.transaction(async (run) => {
        await run.query('INSERT INTO kept VALUES ($1)', [2]);
      });
      expect(await db.query('SELECT n FROM kept')).toEqual([{ n: 2 }]);
      // A snapshot may not change anything (25006).
      await expect(
        db.transaction((run) => run.query('INSERT INTO kept VALUES (3)'), 'snapshot'),
      ).rejects.toMatchObject({ code: '25006' });
      await db.close();
      await db.close();
    });
  });
});
