/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomBytes } from 'node:crypto';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import { ROLES, type AccountRecord, type AccountStore, type Role } from './account-store.js';
import {
  DEFAULT_PASSWORD_COST,
  hashPassword,
  isWeakerThan,
  passwordProblem,
  verifyPassword,
  type PasswordCost,
} from './password.js';

/** An account as it is shown: never with its password hash. */
export interface Account {
  readonly name: string;
  readonly role: Role;
  readonly disabled: boolean;
  /** When it was made, as an ISO 8601 instant. */
  readonly createdAt: string;
}

/** A login that is in force: whose it is, and when it ends if it is not used. */
export interface Session {
  readonly account: Account;
  /** ISO 8601. Using the session moves this on, up to the session's longest life. */
  readonly expiresAt: string;
}

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly session: Session }
  /** No such account, a wrong password or a disabled account: the caller is not told which. */
  | { readonly ok: false; readonly reason: 'bad-credentials' }
  /** Too many wrong passwords for this name; nothing is tried until the wait is over. */
  | { readonly ok: false; readonly reason: 'locked'; readonly retryAfterSeconds: number };

/** Why an account could not be made or changed. The message is for whoever asked. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly code: 'invalid-name' | 'invalid-role' | 'weak-password' | 'exists' | 'last-admin',
    message: string,
  ) {
    super(message);
  }
}

/** A lower-case letter or digit, then up to 63 more of those and `.`, `_`, `-`. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A session ends when it has not been used for this long. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** A session ends this long after its login, used or not. */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** A session's last use is written down at most this often. */
const TOUCH_EVERY_MS = 60 * 1000;

/** This many wrong passwords in a row for one name, and the name is locked for a while. */
export const LOGIN_ATTEMPTS = 5;
const LOCK_FIRST_MS = 30 * 1000;
const LOCK_LONGEST_MS = 15 * 60 * 1000;
/** How many names the count of wrong passwords is kept for; the oldest goes first. */
const ATTEMPTS_KEPT = 10_000;
/**
 * How many passwords are checked at once. Each check takes memory and a
 * thread for a fraction of a second, and anyone can ask for one: beyond
 * this many, a caller is told to come back rather than left to pile up.
 */
export const LOGINS_AT_ONCE = 16;

export interface AccountsOptions {
  readonly store: AccountStore;
  readonly logger?: Logger;
  /** Milliseconds since the epoch, for tests. */
  readonly now?: () => number;
  /** How hard password hashes are to compute. Tests give a low cost to be quick. */
  readonly cost?: PasswordCost;
  readonly idleMs?: number;
  readonly lifetimeMs?: number;
}

/**
 * Who may use the server: local accounts with a role each, and the sessions
 * their logins make.
 *
 * A login gives a token: 32 random bytes, told once to whoever logged in and
 * kept here only as its SHA-256. It is sent back in the `Authorization`
 * header of each request. That was chosen over a cookie because the viewer is
 * served from another origin than the server: a browser attaches a cookie to
 * every request to the server, whichever page made it, and does not attach a
 * header a page did not set, so a token in a header cannot be used by another
 * site on the user's behalf. A token rather than a signed claim, so that a
 * logout, a disabled account or a changed password ends it at once.
 */
export interface Accounts {
  /** Make an account. Throws {@link AccountError}. */
  add(name: string, password: string, role: Role): Promise<Account>;
  /** Null when there is no such account. */
  get(name: string): Account | null;
  list(): Account[];
  /**
   * Give an account another password and end its sessions (but `keepToken`'s,
   * for the one who changed their own). False when there is no such account.
   */
  setPassword(name: string, password: string, keepToken?: string): Promise<boolean>;
  /** False when there is no such account. Throws for the last enabled administrator. */
  setRole(name: string, role: Role): boolean;
  /** Disabling ends the account's sessions. Same answers as {@link setRole}. */
  setDisabled(name: string, disabled: boolean): boolean;
  /** Same answers as {@link setRole}. */
  remove(name: string): boolean;
  login(name: string, password: string): Promise<LoginResult>;
  /** Whether `password` is the account's, counted like a login. For changing one's own. */
  check(name: string, password: string): Promise<LoginResult['ok'] | 'locked'>;
  /** The session a token stands for, or null: unknown, ended, or its account gone or disabled. */
  authenticate(token: string): Session | null;
  logout(token: string): void;
  close(): void;
}

const shown = ({ name, role, disabled, createdAt }: AccountRecord): Account => ({
  name,
  role,
  disabled,
  createdAt,
});

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createAccounts(options: AccountsOptions): Accounts {
  const { store } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? Date.now;
  const cost = options.cost ?? DEFAULT_PASSWORD_COST;
  const idleMs = options.idleMs ?? SESSION_IDLE_MS;
  const lifetimeMs = options.lifetimeMs ?? SESSION_LIFETIME_MS;

  /** Wrong passwords in a row, by the name they were tried for, and until when the name is locked. */
  const attempts = new Map<string, { failures: number; lockedUntil: number }>();
  /** Passwords being checked now. */
  let checking = 0;
  /**
   * What a password is checked against when there is no such account, so
   * that the answer takes as long as for one there is: how long it takes
   * must not say which names exist.
   */
  let decoy: Promise<string> | null = null;

  const key = (name: string): string => name.trim().toLowerCase();

  const expiryOf = (session: { createdAt: number; lastUsedAt: number }): number =>
    Math.min(session.createdAt + lifetimeMs, session.lastUsedAt + idleMs);

  const sweep = (): void => {
    const ended = store.deleteSessionsBefore({
      createdBefore: now() - lifetimeMs,
      usedBefore: now() - idleMs,
    });
    if (ended > 0) logger.debug('sessions-ended', { count: ended });
  };

  const enabledAdmins = (): number =>
    store.accounts().filter((account) => account.role === 'admin' && !account.disabled).length;

  /** Refuse what would leave the server with no administrator who can log in. */
  const keepAnAdmin = (record: AccountRecord, after: { role: Role; disabled: boolean } | null) => {
    const isOne = record.role === 'admin' && !record.disabled;
    const staysOne = after !== null && after.role === 'admin' && !after.disabled;
    if (isOne && !staysOne && enabledAdmins() === 1) {
      throw new AccountError(
        'last-admin',
        'This is the only administrator who can log in. Make another first.',
      );
    }
  };

  const lockedFor = (name: string): number => {
    const entry = attempts.get(name);
    return entry && entry.lockedUntil > now() ? Math.ceil((entry.lockedUntil - now()) / 1000) : 0;
  };

  const failed = (name: string): void => {
    const entry = attempts.get(name) ?? { failures: 0, lockedUntil: 0 };
    attempts.delete(name); // and put back last, as the newest
    entry.failures += 1;
    if (entry.failures >= LOGIN_ATTEMPTS) {
      const wait = Math.min(
        LOCK_FIRST_MS * 2 ** (entry.failures - LOGIN_ATTEMPTS),
        LOCK_LONGEST_MS,
      );
      entry.lockedUntil = now() + wait;
    }
    attempts.set(name, entry);
    if (attempts.size > ATTEMPTS_KEPT) attempts.delete(attempts.keys().next().value!);
    // Not the name: a mistyped one is often a password.
    logger.warn('login-failed', { locked: entry.lockedUntil > now() });
  };

  /** The account, when the password is its own and it may log in. Counts a failure otherwise. */
  const verified = async (
    given: string,
    password: string,
  ): Promise<AccountRecord | 'bad-credentials' | { retryAfterSeconds: number }> => {
    // What cannot be a name is counted under one key: no account has it, and
    // the table of counts must not be filled with whatever text is sent.
    const name = NAME.test(given) ? given : '';
    const wait = lockedFor(name);
    if (wait > 0) return { retryAfterSeconds: wait };
    if (checking >= LOGINS_AT_ONCE) return { retryAfterSeconds: 1 };
    checking += 1;
    let record: AccountRecord | null;
    let right: boolean;
    try {
      record = name === '' ? null : store.account(name);
      right = await verifyPassword(
        password,
        record?.passwordHash ?? (await (decoy ??= hashPassword('no such account', cost))),
      );
    } finally {
      checking -= 1;
    }
    if (!record || !right || record.disabled) {
      failed(name);
      return 'bad-credentials';
    }
    attempts.delete(name);
    return record;
  };

  return {
    async add(given, password, role) {
      const name = key(given);
      if (!NAME.test(name)) {
        throw new AccountError(
          'invalid-name',
          'An account name is 1 to 64 lower-case letters, digits, dots, hyphens and underscores, beginning with a letter or a digit.',
        );
      }
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new AccountError('invalid-role', `A role is one of ${ROLES.join(', ')}.`);
      }
      const problem = passwordProblem(password);
      if (problem) throw new AccountError('weak-password', problem);
      const record: AccountRecord = {
        name,
        passwordHash: await hashPassword(password, cost),
        role,
        disabled: false,
        createdAt: new Date(now()).toISOString(),
      };
      if (!store.insertAccount(record)) {
        throw new AccountError('exists', 'There is an account of that name already.');
      }
      logger.info('account-added', { role });
      return shown(record);
    },

    get(name) {
      const record = store.account(key(name));
      return record ? shown(record) : null;
    },

    list: () => store.accounts().map(shown),

    async setPassword(given, password, keepToken) {
      const name = key(given);
      const problem = passwordProblem(password);
      if (problem) throw new AccountError('weak-password', problem);
      if (!store.account(name)) return false;
      const changed = store.updateAccount(name, {
        passwordHash: await hashPassword(password, cost),
      });
      // Whoever knew the old password is logged out with it.
      if (changed) {
        store.deleteSessionsOf(name, keepToken === undefined ? undefined : hashOf(keepToken));
      }
      return changed;
    },

    setRole(given, role) {
      const name = key(given);
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new AccountError('invalid-role', `A role is one of ${ROLES.join(', ')}.`);
      }
      const record = store.account(name);
      if (!record) return false;
      keepAnAdmin(record, { role, disabled: record.disabled });
      return store.updateAccount(name, { role });
    },

    setDisabled(given, disabled) {
      const name = key(given);
      const record = store.account(name);
      if (!record) return false;
      keepAnAdmin(record, { role: record.role, disabled });
      const changed = store.updateAccount(name, { disabled });
      if (changed && disabled) store.deleteSessionsOf(name);
      return changed;
    },

    remove(given) {
      const name = key(given);
      const record = store.account(name);
      if (!record) return false;
      keepAnAdmin(record, null);
      return store.deleteAccount(name);
    },

    async login(given, password) {
      const name = key(given);
      const record = await verified(name, password);
      if (record === 'bad-credentials') return { ok: false, reason: 'bad-credentials' };
      if ('retryAfterSeconds' in record) return { ok: false, reason: 'locked', ...record };
      // Made at a lower cost than is asked for now: made again, now that the password is at hand.
      if (isWeakerThan(record.passwordHash, cost)) {
        store.updateAccount(name, { passwordHash: await hashPassword(password, cost) });
      }
      sweep();
      const token = randomBytes(32).toString('base64url');
      const at = now();
      store.insertSession({
        tokenHash: hashOf(token),
        account: name,
        createdAt: at,
        lastUsedAt: at,
      });
      logger.info('login', { role: record.role });
      return {
        ok: true,
        token,
        session: {
          account: shown(record),
          expiresAt: new Date(expiryOf({ createdAt: at, lastUsedAt: at })).toISOString(),
        },
      };
    },

    async check(given, password) {
      const record = await verified(key(given), password);
      if (record === 'bad-credentials') return false;
      return 'retryAfterSeconds' in record ? 'locked' : true;
    },

    authenticate(token) {
      const tokenHash = hashOf(token);
      const session = store.session(tokenHash);
      if (!session) return null;
      const at = now();
      if (at >= expiryOf(session)) {
        store.deleteSession(tokenHash);
        return null;
      }
      const record = store.account(session.account);
      if (!record || record.disabled) return null;
      let { lastUsedAt } = session;
      if (at - lastUsedAt >= TOUCH_EVERY_MS) {
        store.touchSession(tokenHash, at);
        lastUsedAt = at;
      }
      return {
        account: shown(record),
        expiresAt: new Date(expiryOf({ createdAt: session.createdAt, lastUsedAt })).toISOString(),
      };
    },

    logout(token) {
      store.deleteSession(hashOf(token));
    },

    close: () => store.close(),
  };
}
