/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `account` command: how the first administrator is made, and how an
// account is put right when no one can log in to do it. It works on the
// accounts in the data directory, with the server running or not. A password
// is never an argument (arguments are seen by every process on the machine,
// and kept in the shell's history): it is typed, or piped in.

import { AccountError, type Accounts } from './accounts/accounts.js';
import { ROLES, type Role } from './accounts/account-store.js';
import type { AuditAction, AuditOutcome } from './audit/audit-store.js';
import type { AuditLog } from './audit/audit.js';

export interface AccountCommandIo {
  /** A line of what was asked for. */
  out(line: string): void;
  /** A line about what went wrong, or how to ask. */
  err(line: string): void;
  /** Ask for a password without showing it. */
  readPassword(prompt: string): Promise<string>;
  /** Whether passwords are typed by someone: then a new one is asked for twice. */
  readonly interactive: boolean;
}

export const ACCOUNT_USAGE = [
  'Usage: account <command>',
  '  add <name> [--admin]      Make an account. The password is asked for.',
  '  list                      Every account, with its role.',
  '  password <name>           Give an account another password, and log it out everywhere.',
  `  role <name> <${ROLES.join('|')}>   Change an account's role.`,
  '  disable <name>            Keep the account, but let no one log in with it.',
  '  enable <name>',
  '  remove <name>',
];

/** A new password: asked for once when piped in, twice when typed. */
async function newPassword(io: AccountCommandIo): Promise<string | null> {
  const password = await io.readPassword('Password: ');
  if (io.interactive && (await io.readPassword('Again: ')) !== password) {
    io.err('The two are not the same. Nothing was changed.');
    return null;
  }
  return password;
}

/** Where a command's changes are written down, and as whose. */
export interface AccountCommandAudit {
  readonly log: AuditLog;
  /**
   * Who ran the command, as the machine knows them. No account is logged in
   * at a command line; this is the only name there is.
   */
  readonly osUser: string | null;
}

/** What a command turned out to be doing, for the audit record. */
interface Doing {
  /** Null until the arguments are understood: a command that is not is not recorded. */
  action: AuditAction | null;
  detail: string | null;
  /** How it ended, if not well. */
  outcome: AuditOutcome;
}

/**
 * Do what the arguments after `account` ask. Gives the exit code: 0 done, 1
 * could not be done, 2 not understood. With an audit log, what was done to
 * the accounts is written to it, as done by a command.
 */
export async function runAccountCommand(
  args: readonly string[],
  accounts: Accounts,
  io: AccountCommandIo,
  audit?: AccountCommandAudit,
): Promise<number> {
  const doing: Doing = { action: null, detail: null, outcome: 'rejected' };
  const code = await carryOut(args, accounts, io, doing);
  if (!audit || doing.action === null) return code;
  try {
    audit.log.record({
      actor: null,
      origin: 'command',
      action: doing.action,
      outcome: code === 0 ? 'ok' : doing.outcome,
      patientId: null,
      studyUid: null,
      seriesUid: null,
      object: args[1]?.toLowerCase() ?? null,
      detail:
        [doing.detail, audit.osUser === null ? null : `os-user=${audit.osUser}`]
          .filter((part) => part !== null)
          .join(' ') || null,
    });
  } catch {
    io.err('This could not be written to the audit log.');
    return 1;
  }
  return code;
}

async function carryOut(
  args: readonly string[],
  accounts: Accounts,
  io: AccountCommandIo,
  doing: Doing,
): Promise<number> {
  const [command, name, ...rest] = args;
  const usage = (): number => {
    for (const line of ACCOUNT_USAGE) io.err(line);
    return 2;
  };
  const missing = (): number => {
    io.err('There is no account of that name.');
    doing.outcome = 'not-found';
    return 1;
  };
  try {
    switch (command) {
      case 'list': {
        if (name !== undefined) return usage();
        doing.action = 'accounts-list';
        const all = accounts.list();
        if (all.length === 0)
          io.out('There are no accounts. Make one with: account add <name> --admin');
        for (const account of all) {
          io.out(`${account.name}\t${account.role}${account.disabled ? '\tdisabled' : ''}`);
        }
        return 0;
      }
      case 'add': {
        const flags = rest.filter((one) => one.startsWith('--'));
        if (!name || name.startsWith('--') || rest.length !== flags.length) return usage();
        if (flags.some((flag) => flag !== '--admin')) return usage();
        const role: Role = flags.includes('--admin') ? 'admin' : 'user';
        doing.action = 'account-create';
        doing.detail = `role=${role}`;
        const password = await newPassword(io);
        if (password === null) return 1;
        const account = await accounts.add(name, password, role);
        io.out(`Made ${account.name} (${account.role}).`);
        return 0;
      }
      case 'password': {
        if (!name || rest.length > 0) return usage();
        doing.action = 'account-change';
        // That it was changed, and never what to.
        doing.detail = 'password';
        if (!accounts.get(name)) return missing();
        const password = await newPassword(io);
        if (password === null) return 1;
        await accounts.setPassword(name, password);
        io.out('Changed. The account is logged out everywhere.');
        return 0;
      }
      case 'role': {
        const [role] = rest;
        if (!name || rest.length !== 1 || !(ROLES as readonly string[]).includes(role)) {
          return usage();
        }
        doing.action = 'account-change';
        doing.detail = `role=${role}`;
        if (!accounts.setRole(name, role as Role)) return missing();
        io.out(`${name.toLowerCase()} is now ${role}.`);
        return 0;
      }
      case 'disable':
      case 'enable': {
        if (!name || rest.length > 0) return usage();
        doing.action = 'account-change';
        doing.detail = `disabled=${command === 'disable'}`;
        if (!accounts.setDisabled(name, command === 'disable')) return missing();
        io.out(command === 'disable' ? 'Disabled, and logged out everywhere.' : 'Enabled.');
        return 0;
      }
      case 'remove': {
        if (!name || rest.length > 0) return usage();
        doing.action = 'account-remove';
        if (!accounts.remove(name)) return missing();
        io.out('Removed.');
        return 0;
      }
      default:
        return usage();
    }
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    io.err(error.message);
    return 1;
  }
}

/**
 * Passwords from this process's standard input. From a terminal, each is
 * typed without being shown. Otherwise the input is read to its end, once,
 * and each password asked for is its next line.
 */
export function terminalPasswords(): Pick<AccountCommandIo, 'readPassword' | 'interactive'> {
  const { stdin, stderr } = process;
  if (stdin.isTTY) {
    return {
      interactive: true,
      readPassword: (prompt) =>
        new Promise((resolve, reject) => {
          let typed = '';
          stderr.write(prompt);
          stdin.setRawMode(true);
          stdin.setEncoding('utf8');
          stdin.resume();
          const end = (): void => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            stderr.write('\n');
          };
          const onData = (chunk: string): void => {
            for (const character of chunk) {
              if (character === '\r' || character === '\n' || character === '\u0004') {
                end();
                return resolve(typed);
              }
              if (character === '\u0003') {
                end();
                return reject(new Error('Cancelled.'));
              }
              if (character === '\u007f' || character === '\b')
                typed = [...typed].slice(0, -1).join('');
              else typed += character;
            }
          };
          stdin.on('data', onData);
        }),
    };
  }
  let lines: Promise<string[]> | null = null;
  const read = async (): Promise<string[]> => {
    const pieces: Buffer[] = [];
    for await (const piece of stdin) pieces.push(piece as Buffer);
    return Buffer.concat(pieces).toString('utf8').split(/\r?\n/);
  };
  return {
    interactive: false,
    readPassword: async () => (await (lines ??= read())).shift() ?? '',
  };
}
