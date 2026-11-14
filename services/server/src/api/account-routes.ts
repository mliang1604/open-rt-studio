/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Logging in and out, and the accounts themselves (#55). The session routes
// are for everyone with an account; the account routes for administrators.

import { AccountError, type Accounts, type Session } from '../accounts/accounts.js';
import { ROLES, type Role } from '../accounts/account-store.js';
import { passwordProblem } from '../accounts/password.js';
import { HttpError, type Route, type RouteRequest } from '../host/routes.js';
import { API_PREFIX, queryOf } from './api-routes.js';

/** The longest body these routes read: a name, a password or two, a role. */
const MAX_BODY_BYTES = 4096;

const invalid = (message: string): HttpError => new HttpError(400, 'invalid-request', message);

/** The request's body as a JSON object with only the properties named, each a string or a boolean. */
async function fields<K extends string>(
  request: RouteRequest,
  known: readonly K[],
): Promise<Partial<Record<K, unknown>>> {
  queryOf(request, []);
  const media = (request.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (media !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'Send the body as application/json.');
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await request.body(MAX_BODY_BYTES)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid('The body is not JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('The body is not a JSON object.');
  }
  for (const name of Object.keys(body)) {
    if (!(known as readonly string[]).includes(name)) {
      throw invalid(`The body may hold only: ${known.join(', ')}.`);
    }
  }
  return body as Partial<Record<K, unknown>>;
}

function textOf(value: unknown, what: string): string {
  if (typeof value !== 'string') throw invalid(`${what} is missing or is not text.`);
  return value;
}

function roleOf(value: unknown): Role {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw invalid(`A role is one of ${ROLES.join(', ')}.`);
  }
  return value as Role;
}

/** An {@link AccountError} as the answer it is. */
function refused(error: unknown): never {
  if (!(error instanceof AccountError)) throw error;
  const conflict = error.code === 'exists' || error.code === 'last-admin';
  throw new HttpError(conflict ? 409 : 400, error.code, error.message);
}

const noSuchAccount = (): HttpError =>
  new HttpError(404, 'not-found', 'There is no account of that name.');

const sessionBody = (session: Session) => ({
  account: session.account,
  expiresAt: session.expiresAt,
});

const NAME_PARAMETER = {
  name: 'name',
  in: 'path',
  description: 'The name the account logs in as.',
} as const;

const ERRORS = {
  400: {
    description: 'The request cannot be read, or asks for what is not allowed.',
    schema: 'Error',
  },
  401: { description: 'Not logged in.', schema: 'Error' },
  403: { description: 'Not an administrator.', schema: 'Error' },
} as const;

/**
 * The routes of a server with accounts: `POST /session` to log in, the rest
 * with the token it gives.
 */
export function accountRoutes(accounts: Accounts): Route[] {
  return [
    {
      method: 'POST',
      path: `${API_PREFIX}/session`,
      access: 'public',
      audit: 'login',
      async handle(request) {
        const body = await fields(request, ['name', 'password']);
        const name = textOf(body.name, 'The name');
        const result = await accounts.login(name, textOf(body.password, 'The password'));
        // Whose login it was, when the name is an account's. What was typed
        // in place of a name may be a password, and is not kept.
        request.audit({
          actor: result.ok ? result.session.account.name : (accounts.get(name)?.name ?? null),
          detail: result.ok || result.reason !== 'locked' ? null : 'locked',
        });
        if (result.ok) {
          return { status: 200, body: { token: result.token, ...sessionBody(result.session) } };
        }
        if (result.reason === 'locked') {
          throw new HttpError(
            429,
            'too-many-attempts',
            'Too many wrong passwords for this name. Wait before trying again.',
            { 'Retry-After': String(result.retryAfterSeconds) },
          );
        }
        // One answer for a wrong name, a wrong password and a disabled account.
        throw new HttpError(401, 'bad-credentials', 'The name or the password is not right.');
      },
      doc: {
        tag: 'Accounts',
        summary: 'Log in',
        description:
          'Gives a token to send with every other request, as `Authorization: Bearer <token>`. ' +
          'It is told once and cannot be asked for again. The session ends when it is logged ' +
          'out, 12 hours after it was last used, or 7 days after the login.',
        requestBody: 'application/json',
        responses: {
          200: { description: 'Logged in.', schema: 'Login' },
          400: ERRORS[400],
          401: { description: 'The name or the password is not right.', schema: 'Error' },
          429: {
            description:
              'Too many wrong passwords for this name; `Retry-After` says how long to wait.',
            schema: 'Error',
          },
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/session`,
      // Asking who one is touches no one's data.
      audit: false,
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: sessionBody(request.session!) };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Who is logged in',
        responses: {
          200: { description: 'The session of the token sent.', schema: 'Session' },
          401: ERRORS[401],
        },
      },
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/session`,
      audit: 'logout',
      handle(request) {
        queryOf(request, []);
        accounts.logout(request.token!);
        return { status: 204, body: null };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Log out',
        responses: { 204: { description: 'The token no longer works.' }, 401: ERRORS[401] },
      },
    },
    {
      method: 'PUT',
      path: `${API_PREFIX}/session/password`,
      audit: 'password-change',
      async handle(request) {
        const body = await fields(request, ['current', 'next']);
        const { name } = request.session!.account;
        const right = await accounts.check(name, textOf(body.current, 'The current password'));
        if (right === 'locked') {
          throw new HttpError(
            429,
            'too-many-attempts',
            'Too many wrong passwords. Wait before trying again.',
          );
        }
        if (!right) {
          throw new HttpError(403, 'bad-credentials', 'The current password is not right.');
        }
        try {
          await accounts.setPassword(name, textOf(body.next, 'The new password'), request.token!);
        } catch (error) {
          refused(error);
        }
        return { status: 204, body: null };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Change your own password',
        description: 'Every other session of the account is logged out.',
        requestBody: 'application/json',
        responses: {
          204: { description: 'Changed.' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: { description: 'The current password is not right.', schema: 'Error' },
          429: { description: 'Too many wrong passwords.', schema: 'Error' },
        },
      },
    },
    {
      method: 'GET',
      path: `${API_PREFIX}/accounts`,
      access: 'admin',
      audit: 'accounts-list',
      handle(request) {
        queryOf(request, []);
        return { status: 200, body: { accounts: accounts.list() } };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Every account',
        responses: {
          200: { description: 'The accounts, by name.', schema: 'AccountList' },
          401: ERRORS[401],
          403: ERRORS[403],
        },
      },
    },
    {
      method: 'POST',
      path: `${API_PREFIX}/accounts`,
      access: 'admin',
      audit: 'account-create',
      async handle(request) {
        const body = await fields(request, ['name', 'password', 'role']);
        const name = textOf(body.name, 'The name');
        const role = roleOf(body.role ?? 'user');
        request.audit({ object: name, detail: `role=${role}` });
        try {
          const account = await accounts.add(name, textOf(body.password, 'The password'), role);
          return { status: 201, body: account };
        } catch (error) {
          return refused(error);
        }
      },
      doc: {
        tag: 'Accounts',
        summary: 'Make an account',
        requestBody: 'application/json',
        responses: {
          201: { description: 'Made.', schema: 'Account' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: ERRORS[403],
          409: { description: 'There is an account of that name already.', schema: 'Error' },
        },
      },
    },
    {
      method: 'PUT',
      path: `${API_PREFIX}/accounts/:name`,
      access: 'admin',
      audit: 'account-change',
      async handle(request) {
        const name = request.params['name'];
        request.audit({ object: name });
        const body = await fields(request, ['role', 'disabled', 'password']);
        if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
          throw invalid('"disabled" is true or false.');
        }
        // Everything asked for is looked at before anything is changed, so
        // that a request is carried out whole or not at all.
        const role = body.role === undefined ? undefined : roleOf(body.role);
        const password =
          body.password === undefined ? undefined : textOf(body.password, 'The password');
        const weak = password === undefined ? null : passwordProblem(password);
        if (weak) throw new HttpError(400, 'weak-password', weak);
        // What was asked to change. That a password was, and never what to.
        request.audit({
          detail:
            [
              ...(role === undefined ? [] : [`role=${role}`]),
              ...(body.disabled === undefined ? [] : [`disabled=${body.disabled}`]),
              ...(password === undefined ? [] : ['password']),
            ].join(' ') || null,
        });
        if (!accounts.get(name)) throw noSuchAccount();
        try {
          if (role !== undefined) accounts.setRole(name, role);
          if (body.disabled !== undefined) accounts.setDisabled(name, body.disabled);
          if (password !== undefined) await accounts.setPassword(name, password);
        } catch (error) {
          refused(error);
        }
        const account = accounts.get(name);
        if (!account) throw noSuchAccount();
        return { status: 200, body: account };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Change an account: its role, whether it is disabled, its password',
        description:
          'Disabling an account or giving it another password logs it out everywhere. ' +
          'The last administrator who can log in cannot be disabled or made a user.',
        parameters: [NAME_PARAMETER],
        requestBody: 'application/json',
        responses: {
          200: { description: 'The account as it is now.', schema: 'Account' },
          400: ERRORS[400],
          401: ERRORS[401],
          403: ERRORS[403],
          404: { description: 'No account of that name.', schema: 'Error' },
          409: { description: 'It is the last administrator who can log in.', schema: 'Error' },
        },
      },
    },
    {
      method: 'DELETE',
      path: `${API_PREFIX}/accounts/:name`,
      access: 'admin',
      audit: 'account-remove',
      handle(request) {
        request.audit({ object: request.params['name'] });
        queryOf(request, []);
        try {
          if (!accounts.remove(request.params['name'])) throw noSuchAccount();
        } catch (error) {
          if (error instanceof HttpError) throw error;
          refused(error);
        }
        return { status: 204, body: null };
      },
      doc: {
        tag: 'Accounts',
        summary: 'Remove an account',
        parameters: [NAME_PARAMETER],
        responses: {
          204: { description: 'Removed, with its sessions.' },
          401: ERRORS[401],
          403: ERRORS[403],
          404: { description: 'No account of that name.', schema: 'Error' },
          409: { description: 'It is the last administrator who can log in.', schema: 'Error' },
        },
      },
    },
  ];
}

/**
 * What a server without accounts answers when asked who is logged in: no
 * one, and no one need be. A client asks this one question of any server:
 * 200 with no account means there is no login, 401 means there is one.
 */
export function openSessionRoute(): Route {
  return {
    method: 'GET',
    path: `${API_PREFIX}/session`,
    access: 'public',
    audit: false,
    handle(request) {
      queryOf(request, []);
      return { status: 200, body: { account: null, expiresAt: null } };
    },
    doc: {
      tag: 'Accounts',
      summary: 'Who is logged in',
      description: 'This server has no accounts: it answers whoever can reach it.',
      responses: { 200: { description: 'No one, and no login is needed.', schema: 'Session' } },
    },
  };
}
