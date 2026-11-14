/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where accounts and sessions are kept: a SQLite database of their own
// (node:sqlite), beside the index and not in it. The index can then move to
// another database (PostgreSQL, #44) without the accounts moving with it, and
// a copy of the index given to someone holds no password hash.

import { DatabaseSync } from 'node:sqlite';

import { migrate, type Migration } from '../pacs-index/migrations.js';

/** What an account may do: `admin` may also manage accounts and configuration. */
export const ROLES = ['admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

export interface AccountRecord {
  /** Lower case; what the account logs in as. */
  readonly name: string;
  readonly passwordHash: string;
  readonly role: Role;
  /** A disabled account is kept, and cannot log in. */
  readonly disabled: boolean;
  /** When it was made, as an ISO 8601 instant. */
  readonly createdAt: string;
}

export interface SessionRecord {
  /** SHA-256 of the token, in hex. The token itself is kept nowhere. */
  readonly tokenHash: string;
  readonly account: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

/** The accounts and their sessions. Its calls are synchronous and short. */
export interface AccountStore {
  account(name: string): AccountRecord | null;
  /** Every account, by name. */
  accounts(): AccountRecord[];
  /** False, and nothing kept, when there is an account of that name already. */
  insertAccount(record: AccountRecord): boolean;
  /** False when there is no such account. */
  updateAccount(
    name: string,
    changes: Partial<Pick<AccountRecord, 'passwordHash' | 'role' | 'disabled'>>,
  ): boolean;
  /** Removes the account and its sessions. False when there is no such account. */
  deleteAccount(name: string): boolean;
  insertSession(record: SessionRecord): void;
  session(tokenHash: string): SessionRecord | null;
  touchSession(tokenHash: string, at: number): void;
  deleteSession(tokenHash: string): void;
  /** End an account's sessions, all or all but one. Says how many. */
  deleteSessionsOf(account: string, exceptTokenHash?: string): number;
  /** End the sessions made before one time or last used before another. Says how many. */
  deleteSessionsBefore(times: {
    readonly createdBefore: number;
    readonly usedBefore: number;
  }): number;
  close(): void;
}

/** Marks a file as an account store of this server ("ORTA"). */
export const ACCOUNT_STORE_APPLICATION_ID = 0x4f525441;

export const ACCOUNT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'accounts and their sessions',
    sql: `
      CREATE TABLE account (
        name TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        account TEXT NOT NULL REFERENCES account (name) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX session_account ON session (account);
    `,
  },
];

type Row = Record<string, string | number | null>;

const toAccount = (row: Row): AccountRecord => ({
  name: String(row['name']),
  passwordHash: String(row['password_hash']),
  role: row['role'] as Role,
  disabled: Number(row['disabled']) !== 0,
  createdAt: String(row['created_at']),
});

const toSession = (row: Row): SessionRecord => ({
  tokenHash: String(row['token_hash']),
  account: String(row['account']),
  createdAt: Number(row['created_at']),
  lastUsedAt: Number(row['last_used_at']),
});

/**
 * The account store in a SQLite database: a file, or `:memory:` for one that
 * lasts as long as the process.
 */
export function openSqliteAccountStore(location: string): AccountStore {
  const db = new DatabaseSync(location);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    // The command that adds an account opens the file while the server has it.
    if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrate(db, ACCOUNT_MIGRATIONS[ACCOUNT_MIGRATIONS.length - 1].version, ACCOUNT_MIGRATIONS, {
      applicationId: ACCOUNT_STORE_APPLICATION_ID,
      noun: 'account store',
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  const changed = (result: { changes: number | bigint }): number => Number(result.changes);

  return {
    account(name) {
      const row = db.prepare('SELECT * FROM account WHERE name = ?').get(name) as Row | undefined;
      return row ? toAccount(row) : null;
    },

    accounts() {
      return (db.prepare('SELECT * FROM account ORDER BY name').all() as Row[]).map(toAccount);
    },

    insertAccount(record) {
      const result = db
        .prepare(
          `INSERT INTO account (name, password_hash, role, disabled, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`,
        )
        .run(
          record.name,
          record.passwordHash,
          record.role,
          record.disabled ? 1 : 0,
          record.createdAt,
        );
      return changed(result) === 1;
    },

    updateAccount(name, changes) {
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if (changes.passwordHash !== undefined) {
        sets.push('password_hash = ?');
        values.push(changes.passwordHash);
      }
      if (changes.role !== undefined) {
        sets.push('role = ?');
        values.push(changes.role);
      }
      if (changes.disabled !== undefined) {
        sets.push('disabled = ?');
        values.push(changes.disabled ? 1 : 0);
      }
      if (sets.length === 0) return this.account(name) !== null;
      const result = db
        .prepare(`UPDATE account SET ${sets.join(', ')} WHERE name = ?`)
        .run(...values, name);
      return changed(result) === 1;
    },

    deleteAccount(name) {
      return changed(db.prepare('DELETE FROM account WHERE name = ?').run(name)) === 1;
    },

    insertSession(record) {
      db.prepare(
        'INSERT INTO session (token_hash, account, created_at, last_used_at) VALUES (?, ?, ?, ?)',
      ).run(record.tokenHash, record.account, record.createdAt, record.lastUsedAt);
    },

    session(tokenHash) {
      const row = db.prepare('SELECT * FROM session WHERE token_hash = ?').get(tokenHash) as
        Row | undefined;
      return row ? toSession(row) : null;
    },

    touchSession(tokenHash, at) {
      db.prepare('UPDATE session SET last_used_at = ? WHERE token_hash = ?').run(at, tokenHash);
    },

    deleteSession(tokenHash) {
      db.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash);
    },

    deleteSessionsOf(account, exceptTokenHash) {
      return changed(
        exceptTokenHash === undefined
          ? db.prepare('DELETE FROM session WHERE account = ?').run(account)
          : db
              .prepare('DELETE FROM session WHERE account = ? AND token_hash <> ?')
              .run(account, exceptTokenHash),
      );
    },

    deleteSessionsBefore({ createdBefore, usedBefore }) {
      return changed(
        db
          .prepare('DELETE FROM session WHERE created_at < ? OR last_used_at < ?')
          .run(createdBefore, usedBefore),
      );
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
