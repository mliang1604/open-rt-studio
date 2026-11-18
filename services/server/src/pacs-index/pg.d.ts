/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node-postgres comes without types. These are the few of its names that
// `postgres.ts` uses, and no more: the rest of the server never sees them.

declare module 'pg' {
  interface QueryResult {
    readonly rows: Record<string, string | number | null>[];
    readonly rowCount: number | null;
  }

  interface PoolClient {
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    /** With `true` the connection is closed and not given to anyone else. */
    release(destroy?: boolean): void;
  }

  interface PoolConfig {
    readonly connectionString: string;
    readonly max?: number;
    readonly connectionTimeoutMillis?: number;
    readonly idleTimeoutMillis?: number;
    readonly application_name?: string;
  }

  interface Pool {
    query(text: string, values?: unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: 'error', listener: (error: Error) => void): this;
  }

  const pg: { readonly Pool: new (config: PoolConfig) => Pool };
  export default pg;
}
