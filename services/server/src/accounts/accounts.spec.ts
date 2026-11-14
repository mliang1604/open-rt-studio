/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLogger } from '../logger.js';
import { openSqliteAccountStore, type AccountStore } from './account-store.js';
import {
  AccountError,
  createAccounts,
  LOGIN_ATTEMPTS,
  LOGINS_AT_ONCE,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  type Accounts,
  type LoginResult,
} from './accounts.js';
import { hashPassword, isWeakerThan, type PasswordCost } from './password.js';

/** Quick to compute, for specs. */
const QUICK: PasswordCost = { logN: 4, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another long enough password';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

interface Made {
  readonly accounts: Accounts;
  readonly store: AccountStore;
  /** Move the clock on. */
  readonly pass: (ms: number) => void;
  readonly log: Record<string, unknown>[];
}

const open: AccountStore[] = [];
afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

function make(store: AccountStore = openSqliteAccountStore(':memory:')): Made {
  open.push(store);
  let now = Date.UTC(2026, 10, 14, 9, 0, 0);
  const log: Record<string, unknown>[] = [];
  const accounts = createAccounts({
    store,
    cost: QUICK,
    now: () => now,
    logger: createLogger({
      level: 'debug',
      write: (line) => log.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  return { accounts, store, pass: (ms) => (now += ms), log };
}

/** The token of a login that must succeed. */
async function tokenOf(accounts: Accounts, name: string, password = PASSWORD): Promise<string> {
  const result = await accounts.login(name, password);
  if (!result.ok) throw new Error(`login refused: ${result.reason}`);
  return result.token;
}

const BAD: LoginResult = { ok: false, reason: 'bad-credentials' };

describe('accounts', () => {
  it('makes an account under a lower-case name, and shows it without its password', async () => {
    const { accounts, store } = make();
    const made = await accounts.add('  Ada.Lovelace ', PASSWORD, 'admin');
    expect(made).toEqual({
      name: 'ada.lovelace',
      role: 'admin',
      disabled: false,
      createdAt: '2026-11-14T09:00:00.000Z',
    });
    expect(accounts.get('ADA.LOVELACE')).toEqual(made);
    expect(accounts.list()).toEqual([made]);
    // What is kept is a hash, at the cost asked for.
    const kept = store.account('ada.lovelace')!.passwordHash;
    expect(kept).not.toContain(PASSWORD);
    expect(isWeakerThan(kept, QUICK)).toBe(false);
    expect(JSON.stringify(accounts.list())).not.toContain(kept);
  });

  it.each([
    ['', 'invalid-name'],
    ['two words', 'invalid-name'],
    ['-leading', 'invalid-name'],
    ['a/b', 'invalid-name'],
    ['adä', 'invalid-name'],
    ['a'.repeat(65), 'invalid-name'],
  ])('refuses the name %j', async (name, code) => {
    const { accounts } = make();
    await expect(accounts.add(name, PASSWORD, 'user')).rejects.toMatchObject({ code });
    expect(accounts.list()).toEqual([]);
  });

  it('refuses a short password, a role it does not know, and a name that is taken', async () => {
    const { accounts } = make();
    await expect(accounts.add('ada', 'short', 'user')).rejects.toThrow(
      new AccountError('weak-password', 'A password has at least 12 characters.'),
    );
    await expect(accounts.add('ada', PASSWORD, 'root' as never)).rejects.toMatchObject({
      code: 'invalid-role',
    });
    await accounts.add('ada', PASSWORD, 'user');
    await expect(accounts.add('ADA', OTHER_PASSWORD, 'admin')).rejects.toMatchObject({
      code: 'exists',
    });
    // The first is as it was.
    expect(accounts.get('ada')?.role).toBe('user');
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });
});

describe('logging in', () => {
  it('gives a token for the right password, and keeps only its hash', async () => {
    const { accounts, store, log } = make();
    await accounts.add('ada', PASSWORD, 'user');
    const result = await accounts.login('Ada', PASSWORD);
    if (!result.ok) throw new Error('refused');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session).toEqual({
      account: accounts.get('ada'),
      expiresAt: new Date(Date.UTC(2026, 10, 14, 9) + SESSION_IDLE_MS).toISOString(),
    });
    const hash = createHash('sha256').update(result.token).digest('hex');
    expect(store.session(hash)).toMatchObject({ account: 'ada' });
    expect(store.session(result.token)).toBeNull();
    // A second login is a second session, with a token of its own.
    expect(await tokenOf(accounts, 'ada')).not.toBe(result.token);
    // The log says that someone logged in, not who.
    expect(JSON.stringify(log)).not.toContain('ada');
    expect(log).toContainEqual(
      expect.objectContaining({ level: 'info', event: 'login', role: 'user' }),
    );
  });

  it('gives one answer for a wrong password, a name it does not know and a disabled account', async () => {
    const { accounts, log } = make();
    await accounts.add('ada', PASSWORD, 'user');
    await accounts.add('bob', PASSWORD, 'user');
    await accounts.add('root', PASSWORD, 'admin');
    accounts.setDisabled('bob', true);
    expect(await accounts.login('ada', OTHER_PASSWORD)).toEqual(BAD);
    expect(await accounts.login('nobody', PASSWORD)).toEqual(BAD);
    expect(await accounts.login('not a name', PASSWORD)).toEqual(BAD);
    expect(await accounts.login('bob', PASSWORD)).toEqual(BAD);
    // Nor does the log say which name, or what was typed for it.
    const logged = JSON.stringify(log);
    for (const secret of ['nobody', 'not a name', OTHER_PASSWORD, PASSWORD]) {
      expect(logged).not.toContain(secret);
    }
    expect(log.filter((entry) => entry['event'] === 'login-failed')).toHaveLength(4);
  });

  it(`locks a name after ${LOGIN_ATTEMPTS} wrong passwords in a row, for longer each time`, async () => {
    const { accounts, pass } = make();
    await accounts.add('ada', PASSWORD, 'user');
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
      expect(await accounts.login('ada', OTHER_PASSWORD)).toEqual(BAD);
    }
    // Locked: the right password is not even tried.
    expect(await accounts.login('ada', PASSWORD)).toEqual({
      ok: false,
      reason: 'locked',
      retryAfterSeconds: 30,
    });
    pass(29_000);
    expect(await accounts.login('ADA', PASSWORD)).toMatchObject({ retryAfterSeconds: 1 });
    pass(1_000);
    // One more wrong one, and the wait is twice as long.
    expect(await accounts.login('ada', OTHER_PASSWORD)).toEqual(BAD);
    expect(await accounts.login('ada', PASSWORD)).toMatchObject({ retryAfterSeconds: 60 });
    pass(60_000);
    // The right password ends it, and the count begins again.
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
    for (let i = 0; i < LOGIN_ATTEMPTS - 1; i++) await accounts.login('ada', OTHER_PASSWORD);
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it('waits no longer than a quarter of an hour, and locks a name it does not know like one it does', async () => {
    const { accounts, pass } = make();
    await accounts.add('ada', PASSWORD, 'user');
    let longest = 0;
    for (let i = 0; i < 20; i++) {
      const result = await accounts.login('nobody', PASSWORD);
      if (!result.ok && result.reason === 'locked') {
        longest = Math.max(longest, result.retryAfterSeconds);
        pass(result.retryAfterSeconds * 1000);
      }
    }
    expect(longest).toBe(15 * 60);
    // One name's wrong passwords do not lock another.
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it('counts everything that cannot be a name as one, and keeps no text it was sent', async () => {
    const { accounts } = make();
    await accounts.add('ada', PASSWORD, 'user');
    // Five different texts, none of them a name: together they are five wrong passwords.
    for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
      expect(await accounts.login(`not a name ${'x'.repeat(i * 1000)}`, PASSWORD)).toEqual(BAD);
    }
    expect(await accounts.login('yet another text that is no name', PASSWORD)).toMatchObject({
      reason: 'locked',
    });
    // A real name is not locked with them.
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it(`checks at most ${LOGINS_AT_ONCE} passwords at once, and tells the rest to come back`, async () => {
    const { accounts } = make();
    for (let i = 0; i < 40; i++) await accounts.add(`user${i}`, PASSWORD, 'user');
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => accounts.login(`user${i}`, PASSWORD)),
    );
    const told = results.filter((result) => !result.ok && result.reason === 'locked');
    expect(results.filter((result) => result.ok)).toHaveLength(LOGINS_AT_ONCE);
    expect(told).toHaveLength(40 - LOGINS_AT_ONCE);
    expect(told[0]).toEqual({ ok: false, reason: 'locked', retryAfterSeconds: 1 });
    // Being told to come back is not a wrong password: no name was locked by it.
    expect((await accounts.login('user39', PASSWORD)).ok).toBe(true);
  });

  it('makes a hash again at the cost asked for now, when its password is given', async () => {
    const store = openSqliteAccountStore(':memory:');
    store.insertAccount({
      name: 'ada',
      passwordHash: await hashPassword(PASSWORD, { logN: 3, r: 8, p: 1 }),
      role: 'user',
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const { accounts } = make(store);
    expect(isWeakerThan(store.account('ada')!.passwordHash, QUICK)).toBe(true);
    // A wrong password changes nothing.
    await accounts.login('ada', OTHER_PASSWORD);
    expect(isWeakerThan(store.account('ada')!.passwordHash, QUICK)).toBe(true);
    await tokenOf(accounts, 'ada');
    expect(isWeakerThan(store.account('ada')!.passwordHash, QUICK)).toBe(false);
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });
});

describe('a session', () => {
  it('stands for its account, and for no one once it is logged out', async () => {
    const { accounts } = make();
    await accounts.add('ada', PASSWORD, 'admin');
    const token = await tokenOf(accounts, 'ada');
    expect(accounts.authenticate(token)?.account).toEqual(accounts.get('ada'));
    expect(accounts.authenticate(`${token}x`)).toBeNull();
    expect(accounts.authenticate('')).toBeNull();
    const second = await tokenOf(accounts, 'ada');
    accounts.logout(token);
    expect(accounts.authenticate(token)).toBeNull();
    // Only that one.
    expect(accounts.authenticate(second)).not.toBeNull();
  });

  it('ends when it has not been used for 12 hours, and using it moves that on', async () => {
    const { accounts, pass } = make();
    await accounts.add('ada', PASSWORD, 'user');
    const token = await tokenOf(accounts, 'ada');
    pass(11 * HOUR);
    const used = accounts.authenticate(token);
    expect(used?.expiresAt).toBe(
      new Date(Date.UTC(2026, 10, 14, 20) + SESSION_IDLE_MS).toISOString(),
    );
    pass(11 * HOUR);
    expect(accounts.authenticate(token)).not.toBeNull();
    pass(SESSION_IDLE_MS);
    expect(accounts.authenticate(token)).toBeNull();
    // And stays ended.
    expect(accounts.authenticate(token)).toBeNull();
  });

  it('ends 7 days after its login however much it is used', async () => {
    const { accounts, pass } = make();
    await accounts.add('ada', PASSWORD, 'user');
    const token = await tokenOf(accounts, 'ada');
    let last = '';
    for (let used = 0; used + 6 * HOUR < SESSION_LIFETIME_MS; used += 6 * HOUR) {
      pass(6 * HOUR);
      last = accounts.authenticate(token)!.expiresAt;
    }
    // Its end is no later than the seventh day.
    expect(last).toBe(new Date(Date.UTC(2026, 10, 21, 9)).toISOString());
    pass(6 * HOUR);
    expect(accounts.authenticate(token)).toBeNull();
  });

  it('ends with its account: disabled, removed, or given another password', async () => {
    const { accounts } = make();
    await accounts.add('root', PASSWORD, 'admin');
    for (const end of [
      (name: string) => accounts.setDisabled(name, true),
      (name: string) => accounts.remove(name),
      (name: string) => accounts.setPassword(name, OTHER_PASSWORD),
    ]) {
      await accounts.add('ada', PASSWORD, 'user');
      const token = await tokenOf(accounts, 'ada');
      expect(accounts.authenticate(token)).not.toBeNull();
      await end('ada');
      expect(accounts.authenticate(token)).toBeNull();
      accounts.remove('ada');
    }
  });

  it('is not brought back by enabling the account again', async () => {
    const { accounts } = make();
    await accounts.add('root', PASSWORD, 'admin');
    await accounts.add('ada', PASSWORD, 'user');
    const token = await tokenOf(accounts, 'ada');
    accounts.setDisabled('ada', true);
    accounts.setDisabled('ada', false);
    expect(accounts.authenticate(token)).toBeNull();
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it('keeps the session of whoever changed their own password, and ends their others', async () => {
    const { accounts } = make();
    await accounts.add('ada', PASSWORD, 'user');
    const here = await tokenOf(accounts, 'ada');
    const elsewhere = await tokenOf(accounts, 'ada');
    expect(await accounts.setPassword('ada', OTHER_PASSWORD, here)).toBe(true);
    expect(accounts.authenticate(here)).not.toBeNull();
    expect(accounts.authenticate(elsewhere)).toBeNull();
    expect(await accounts.login('ada', PASSWORD)).toEqual(BAD);
    expect((await accounts.login('ada', OTHER_PASSWORD)).ok).toBe(true);
    await expect(accounts.setPassword('ada', 'short')).rejects.toMatchObject({
      code: 'weak-password',
    });
    expect(await accounts.setPassword('nobody', OTHER_PASSWORD)).toBe(false);
  });

  it('is cleared away once it has ended, at the next login', async () => {
    const { accounts, store, pass } = make();
    await accounts.add('ada', PASSWORD, 'user');
    const old = await tokenOf(accounts, 'ada');
    const hash = createHash('sha256').update(old).digest('hex');
    pass(SESSION_IDLE_MS + MINUTE);
    expect(store.session(hash)).not.toBeNull();
    await tokenOf(accounts, 'ada');
    expect(store.session(hash)).toBeNull();
  });
});

describe('roles', () => {
  it('changes a role, and answers false for an account there is not', async () => {
    const { accounts } = make();
    await accounts.add('root', PASSWORD, 'admin');
    await accounts.add('ada', PASSWORD, 'user');
    expect(accounts.setRole('ada', 'admin')).toBe(true);
    expect(accounts.get('ada')?.role).toBe('admin');
    expect(accounts.setRole('nobody', 'admin')).toBe(false);
    expect(accounts.setDisabled('nobody', true)).toBe(false);
    expect(accounts.remove('nobody')).toBe(false);
    expect(() => accounts.setRole('ada', 'owner' as never)).toThrow(AccountError);
  });

  it('keeps one administrator who can log in, whatever is asked', async () => {
    const { accounts } = make();
    await accounts.add('root', PASSWORD, 'admin');
    await accounts.add('ada', PASSWORD, 'user');
    const last = { code: 'last-admin' };
    expect(() => accounts.setRole('root', 'user')).toThrow(expect.objectContaining(last));
    expect(() => accounts.setDisabled('root', true)).toThrow(expect.objectContaining(last));
    expect(() => accounts.remove('root')).toThrow(expect.objectContaining(last));
    expect(accounts.get('root')).toMatchObject({ role: 'admin', disabled: false });

    // A disabled administrator does not count as one.
    await accounts.add('eve', PASSWORD, 'admin');
    accounts.setDisabled('eve', true);
    expect(() => accounts.remove('root')).toThrow(expect.objectContaining(last));

    // With another who can log in, each is allowed.
    accounts.setDisabled('eve', false);
    expect(accounts.setRole('root', 'user')).toBe(true);
    expect(() => accounts.setDisabled('eve', true)).toThrow(expect.objectContaining(last));
    // What is not an administrator can always go.
    expect(accounts.remove('ada')).toBe(true);
    expect(accounts.remove('root')).toBe(true);
  });
});

describe('the account store in a file', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-account-store-'));
  });
  afterEach(async () => {
    for (const store of open.splice(0)) store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  it('keeps accounts and sessions across a restart', async () => {
    const file = join(directory, 'accounts.sqlite');
    const first = make(openSqliteAccountStore(file));
    await first.accounts.add('ada', PASSWORD, 'admin');
    const token = await tokenOf(first.accounts, 'ada');
    first.accounts.close();

    const second = make(openSqliteAccountStore(file));
    expect(second.accounts.list().map((account) => account.name)).toEqual(['ada']);
    expect(second.accounts.authenticate(token)?.account.name).toBe('ada');
    expect((await second.accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it('is seen by a second process that has the same file open', async () => {
    const file = join(directory, 'accounts.sqlite');
    const server = make(openSqliteAccountStore(file));
    const command = make(openSqliteAccountStore(file));
    await command.accounts.add('ada', PASSWORD, 'admin');
    const token = await tokenOf(server.accounts, 'ada');
    command.accounts.setDisabled('ada', false);
    await command.accounts.add('eve', PASSWORD, 'admin');
    command.accounts.setDisabled('ada', true);
    expect(server.accounts.authenticate(token)).toBeNull();
  });

  it('refuses a database that is something else', () => {
    const file = join(directory, 'other.sqlite');
    const other = new DatabaseSync(file);
    other.exec('CREATE TABLE note (text TEXT)');
    other.close();
    expect(() => openSqliteAccountStore(file)).toThrow(
      'The database holds something else; it is not an account store.',
    );
  });
});
