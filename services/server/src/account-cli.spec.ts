/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ACCOUNT_USAGE, runAccountCommand } from './account-cli.js';
import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts, type Accounts } from './accounts/accounts.js';
import { openSqliteAuditStore } from './audit/audit-store.js';
import { createAuditLog, type AuditLog } from './audit/audit.js';

// The command's own logic, with the passwords handed to it. That it reads
// them from standard input, and works on the data directory a server has
// open, is tested on the built process (main.spec.ts).

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another long enough password';

interface Ran {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  /** What each password was asked for with. */
  readonly prompts: string[];
}

let accounts: Accounts;
/** Where the command writes what it did, in the tests that give it one. */
let audit: AuditLog | null = null;
afterEach(() => {
  audit?.close();
  audit = null;
});
beforeEach(() => {
  accounts = createAccounts({
    store: openSqliteAccountStore(':memory:'),
    cost: { logN: 4, r: 8, p: 1 },
  });
});
afterEach(() => accounts.close());

/** Run the command with these passwords to give, typed (asked twice) or piped (once). */
async function run(
  args: readonly string[],
  passwords: readonly string[] = [],
  interactive = false,
): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const left = [...passwords];
  const code = await runAccountCommand(
    args,
    accounts,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      interactive,
      readPassword: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(left.shift() ?? '');
      },
    },
    audit ? { log: audit, osUser: 'operator' } : undefined,
  );
  return { code, out, err, prompts };
}

describe('account add', () => {
  it('makes a user, or with --admin an administrator, who can then log in', async () => {
    expect(await run(['add', 'Ada'], [PASSWORD])).toMatchObject({
      code: 0,
      out: ['Made ada (user).'],
      err: [],
      prompts: ['Password: '],
    });
    expect(await run(['add', 'root', '--admin'], [PASSWORD])).toMatchObject({
      code: 0,
      out: ['Made root (admin).'],
    });
    expect(accounts.list().map((account) => `${account.name} ${account.role}`)).toEqual([
      'ada user',
      'root admin',
    ]);
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
  });

  it('asks twice for a password that is typed, and makes nothing when the two differ', async () => {
    const differ = await run(['add', 'ada'], [PASSWORD, OTHER_PASSWORD], true);
    expect(differ).toMatchObject({
      code: 1,
      out: [],
      err: ['The two are not the same. Nothing was changed.'],
      prompts: ['Password: ', 'Again: '],
    });
    expect(accounts.list()).toEqual([]);
    expect((await run(['add', 'ada'], [PASSWORD, PASSWORD], true)).code).toBe(0);
  });

  it('says why an account was not made', async () => {
    expect(await run(['add', 'ada'], ['short'])).toMatchObject({
      code: 1,
      err: ['A password has at least 12 characters.'],
    });
    expect((await run(['add', 'two words'], [PASSWORD])).err[0]).toContain('An account name is');
    await run(['add', 'ada'], [PASSWORD]);
    expect(await run(['add', 'ada'], [OTHER_PASSWORD])).toMatchObject({
      code: 1,
      err: ['There is an account of that name already.'],
    });
    // Never the password, in what it says.
    expect(JSON.stringify(await run(['add', 'eve'], [PASSWORD]))).not.toContain(PASSWORD);
  });

  it.each([
    [['add']],
    [['add', '--admin']],
    [['add', 'ada', '--owner']],
    [['add', 'ada', 'admin']],
    // A password is not an argument: it would be seen by every process, and kept by the shell.
    [['add', 'ada', '--admin', PASSWORD]],
  ])('does not understand %j, and asks for no password', async (args) => {
    const ran = await run(args, [PASSWORD]);
    expect(ran).toMatchObject({ code: 2, out: [], err: ACCOUNT_USAGE, prompts: [] });
    expect(accounts.list()).toEqual([]);
  });
});

describe('account list', () => {
  it('says how to make the first account when there is none', async () => {
    expect(await run(['list'])).toMatchObject({
      code: 0,
      out: ['There are no accounts. Make one with: account add <name> --admin'],
    });
  });

  it('gives each account with its role, and whether it is disabled', async () => {
    await accounts.add('root', PASSWORD, 'admin');
    await accounts.add('ada', PASSWORD, 'user');
    accounts.setDisabled('ada', true);
    expect((await run(['list'])).out).toEqual(['ada\tuser\tdisabled', 'root\tadmin']);
  });
});

describe('the other commands', () => {
  beforeEach(async () => {
    await accounts.add('root', PASSWORD, 'admin');
    await accounts.add('ada', PASSWORD, 'user');
  });

  it('gives an account another password and logs it out', async () => {
    const before = await accounts.login('ada', PASSWORD);
    expect(await run(['password', 'ada'], [OTHER_PASSWORD])).toMatchObject({
      code: 0,
      out: ['Changed. The account is logged out everywhere.'],
    });
    expect(before.ok && accounts.authenticate(before.token)).toBeNull();
    expect((await accounts.login('ada', OTHER_PASSWORD)).ok).toBe(true);
    expect((await run(['password', 'ada'], ['short'])).code).toBe(1);
    // An account there is not is said before a password is asked for.
    expect(await run(['password', 'nobody'], [OTHER_PASSWORD])).toMatchObject({
      code: 1,
      err: ['There is no account of that name.'],
      prompts: [],
    });
  });

  it('changes a role', async () => {
    expect(await run(['role', 'Ada', 'admin'])).toMatchObject({
      code: 0,
      out: ['ada is now admin.'],
    });
    expect(accounts.get('ada')?.role).toBe('admin');
    expect((await run(['role', 'ada', 'owner'])).code).toBe(2);
    expect((await run(['role', 'ada'])).code).toBe(2);
    expect((await run(['role', 'nobody', 'user'])).code).toBe(1);
  });

  it('disables and enables', async () => {
    expect((await run(['disable', 'ada'])).out).toEqual(['Disabled, and logged out everywhere.']);
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(false);
    expect((await run(['enable', 'ada'])).out).toEqual(['Enabled.']);
    expect((await accounts.login('ada', PASSWORD)).ok).toBe(true);
    expect((await run(['disable', 'nobody'])).code).toBe(1);
  });

  it('removes', async () => {
    expect(await run(['remove', 'ada'])).toMatchObject({ code: 0, out: ['Removed.'] });
    expect(accounts.get('ada')).toBeNull();
    expect((await run(['remove', 'ada'])).code).toBe(1);
  });

  it('keeps the last administrator who can log in, and says so', async () => {
    const said = ['This is the only administrator who can log in. Make another first.'];
    for (const args of [
      ['remove', 'root'],
      ['disable', 'root'],
      ['role', 'root', 'user'],
    ]) {
      expect(await run(args)).toMatchObject({ code: 1, out: [], err: said });
    }
    expect(accounts.get('root')).toMatchObject({ role: 'admin', disabled: false });
  });

  it.each([
    [[]],
    [['promote', 'ada']],
    [['list', 'ada']],
    [['remove']],
    [['enable', 'ada', 'now']],
  ])('does not understand %j', async (args) => {
    expect(await run(args)).toMatchObject({ code: 2, out: [], err: ACCOUNT_USAGE });
  });
});

describe('with an audit log', () => {
  beforeEach(() => {
    audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
  });
  const records = () => [...audit!.all()];

  it('writes down what was done to which account, as done by a command, and by whom on the machine', async () => {
    await run(['add', 'Root', '--admin'], [PASSWORD]);
    await run(['add', 'ada'], [PASSWORD]);
    await run(['role', 'ada', 'admin']);
    await run(['disable', 'ada']);
    await run(['enable', 'ada']);
    await run(['password', 'ada'], [OTHER_PASSWORD]);
    await run(['list']);
    await run(['remove', 'ada']);
    const command = { actor: null, origin: 'command', outcome: 'ok', patientId: null };
    expect(records()).toMatchObject([
      {
        ...command,
        action: 'account-create',
        object: 'root',
        detail: 'role=admin os-user=operator',
      },
      { ...command, action: 'account-create', object: 'ada', detail: 'role=user os-user=operator' },
      {
        ...command,
        action: 'account-change',
        object: 'ada',
        detail: 'role=admin os-user=operator',
      },
      {
        ...command,
        action: 'account-change',
        object: 'ada',
        detail: 'disabled=true os-user=operator',
      },
      {
        ...command,
        action: 'account-change',
        object: 'ada',
        detail: 'disabled=false os-user=operator',
      },
      { ...command, action: 'account-change', object: 'ada', detail: 'password os-user=operator' },
      { ...command, action: 'accounts-list', object: null, detail: 'os-user=operator' },
      { ...command, action: 'account-remove', object: 'ada', detail: 'os-user=operator' },
    ]);
    const all = JSON.stringify(records());
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(OTHER_PASSWORD);
  });

  it('writes down what could not be done, and how it ended', async () => {
    await run(['add', 'root', '--admin'], [PASSWORD]);
    await run(['add', 'root'], [PASSWORD]);
    await run(['add', 'ada'], ['short']);
    await run(['add', 'ada'], [PASSWORD, OTHER_PASSWORD], true);
    await run(['remove', 'nobody']);
    await run(['role', 'nobody', 'admin']);
    await run(['remove', 'root']);
    expect(records().slice(1)).toMatchObject([
      { action: 'account-create', object: 'root', outcome: 'rejected', count: 1 },
      // A password too short, then two that differ: the same thing, refused twice.
      { action: 'account-create', object: 'ada', outcome: 'rejected', count: 2 },
      { action: 'account-remove', object: 'nobody', outcome: 'not-found' },
      { action: 'account-change', object: 'nobody', outcome: 'not-found' },
      { action: 'account-remove', object: 'root', outcome: 'rejected' },
    ]);
  });

  it('writes nothing for a command it did not understand', async () => {
    expect((await run(['promote', 'ada'])).code).toBe(2);
    expect((await run(['remove'])).code).toBe(2);
    expect(records()).toEqual([]);
  });

  it('says so, and fails, when what it did could not be written down', async () => {
    audit!.close();
    const made = await run(['add', 'ada'], [PASSWORD]);
    expect(made).toMatchObject({
      code: 1,
      out: ['Made ada (user).'],
      err: ['This could not be written to the audit log.'],
    });
    // Closed already; the afterEach closes it again, which does nothing.
  });
});
