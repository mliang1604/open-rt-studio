/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one file that imports node-postgres (`pg`). The PostgreSQL index and
// its migrations ask their questions through what is here, which sees to
// two things for all of them:
//
// - Nothing of what PostgreSQL says of a failure leaves but its code. Its
//   messages quote what they were given ('invalid input syntax for type
//   bigint: "..."', 'Key (patient_id, issuer)=(...) already exists'), and
//   the server's log holds no patient identifiers.
// - Text goes in without the character U+0000, which PostgreSQL does not
//   keep in text and a file may have in a name.
//
// The lint rule for the server refuses the import anywhere else.

// eslint-disable-next-line no-restricted-imports
import pg from 'pg';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import type { Row } from './entries.js';
import { IndexDatabaseError } from './pacs-index.js';

/** What a statement may be asked with. */
export type SqlValue = string | number | null | readonly string[];

/** Something a statement can be put to: the database, or one connection in a transaction. */
export interface Runner {
  /** The rows of the answer. Without values, the text may hold several statements. */
  query(sql: string, values?: readonly SqlValue[]): Promise<Row[]>;
}

/**
 * How a transaction sees the database. `write` (the default): each statement
 * sees what was committed before it. `snapshot`: every statement sees the
 * database as it was at the first, and none may change it.
 */
export type TransactionMode = 'write' | 'snapshot';

export interface Database extends Runner {
  /**
   * All of the body, or none of it, on one connection. What the body throws
   * is thrown on, after what it did has been taken back.
   */
  transaction<T>(body: (run: Runner) => Promise<T>, mode?: TransactionMode): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly logger?: Logger;
  /** How many connections are kept at most. 10 by default. */
  readonly connections?: number;
}

/** How long a connection may take to be made before the database counts as not reached. */
export const CONNECT_TIMEOUT_MS = 10_000;

const CODE = /^[0-9A-Z_]{1,32}$/;

/** What went wrong, as its code and nothing else. */
export function databaseError(error: unknown): IndexDatabaseError {
  if (error instanceof IndexDatabaseError) return error;
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && CODE.test(code)) return new IndexDatabaseError(code);
  // The pool's own failures have no code: only that it waited too long is told apart.
  return new IndexDatabaseError(
    typeof message === 'string' && /timeout/i.test(message) ? 'TIMEOUT' : 'UNKNOWN',
  );
}

const clean = (value: SqlValue): unknown => {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map((one: string) => one.replaceAll('\u0000', ''));
  return value;
};

const BEGIN: Readonly<Record<TransactionMode, string>> = {
  write: 'BEGIN',
  snapshot: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
};

/**
 * A pool of connections to the PostgreSQL database a connection string
 * names (`postgresql://user:password@host:5432/database`; what it leaves
 * out is taken from the `PG...` variables of the environment, as libpq
 * does). Nothing is connected until the first statement.
 *
 * The string holds a password: it is never logged, and never part of an
 * error.
 */
export function connect(url: string, options: DatabaseOptions = {}): Database {
  const logger = options.logger ?? SILENT_LOGGER;
  let pool: InstanceType<typeof pg.Pool>;
  try {
    pool = new pg.Pool({
      connectionString: url,
      max: options.connections ?? 10,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: 'open-rt-studio',
    });
  } catch {
    // The string could not be read as an address.
    throw new IndexDatabaseError('ADDRESS');
  }
  // A connection that is lost while it waits in the pool: the pool replaces
  // it. Without a listener the error would end the process.
  pool.on('error', (error) => {
    logger.warn('index-connection-lost', { code: databaseError(error).code });
  });

  const ask = async (
    on: { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> },
    sql: string,
    values?: readonly SqlValue[],
  ): Promise<Row[]> => {
    try {
      const answer = await on.query(sql, values?.map(clean));
      // Several statements give several answers; none of ours is read then.
      return Array.isArray(answer) ? [] : answer.rows;
    } catch (error) {
      throw databaseError(error);
    }
  };

  let closed = false;
  return {
    query: (sql, values) => ask(pool, sql, values),

    async transaction(body, mode = 'write') {
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw databaseError(error);
      }
      let lost = false;
      try {
        await ask(client, BEGIN[mode]);
        const result = await body({ query: (sql, values) => ask(client, sql, values) });
        await ask(client, 'COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Not even that: the connection is of no more use.
          lost = true;
        }
        throw error;
      } finally {
        client.release(lost);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
