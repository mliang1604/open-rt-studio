/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package, and not built.
//
// The tests of the index in PostgreSQL run where there is a PostgreSQL to
// run them against, which OPEN_RT_STUDIO_TEST_POSTGRES names as a connection
// string. In CI that is the "PostgreSQL index" job, which starts one as a
// service (REQUIRE_POSTGRES=1 there makes a missing one a failure, not a
// skip). Elsewhere they are skipped. PostgreSQL is a test peer there and at
// run time a database someone else runs: it is never bundled.
//
// Each test gets a schema of its own in that database, so that every index
// begins empty and none sees another's; the schemas are dropped at the end.

import { randomBytes } from 'node:crypto';

import { connect, type Database } from './postgres.js';

const ADDRESS = process.env['OPEN_RT_STUDIO_TEST_POSTGRES'] ?? '';

/** Whether a PostgreSQL must be there: its absence fails the run. */
export const POSTGRES_REQUIRED = process.env['REQUIRE_POSTGRES'] === '1';
/** Whether the tests against PostgreSQL run. */
export const POSTGRES = ADDRESS !== '' || POSTGRES_REQUIRED;

export interface TestSchemas {
  /** A connection string for a new, empty schema of the test database. */
  fresh(): Promise<string>;
  /** Statements in a schema `fresh` gave, for a test to look at it or prepare it. */
  within(url: string): Database;
  /** Drop every schema `fresh` gave, and close what was opened here. */
  drop(): Promise<void>;
}

/** The schemas of one spec file. */
export function testSchemas(): TestSchemas {
  if (ADDRESS === '') {
    throw new Error(
      'OPEN_RT_STUDIO_TEST_POSTGRES names no PostgreSQL for the tests to run against.',
    );
  }
  const admin = connect(ADDRESS, { connections: 2 });
  const made: string[] = [];
  const opened: Database[] = [];
  return {
    async fresh() {
      // Small letters and digits: it goes into statements as it is.
      const schema = `ors_test_${randomBytes(8).toString('hex')}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      made.push(schema);
      const url = new URL(ADDRESS);
      // Every connection made with this string works in the schema, and in no other.
      url.searchParams.set('options', `-c search_path=${schema}`);
      return url.href;
    },
    within(url) {
      const db = connect(url, { connections: 2 });
      opened.push(db);
      return db;
    },
    async drop() {
      await Promise.all(opened.splice(0).map((db) => db.close()));
      for (const schema of made.splice(0)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
