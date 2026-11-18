/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which route answers a call, who may have the answer, and the record of
// who had it: the part of serving the API that knows nothing of how the call
// arrived. The HTTP host puts the network in front of it; the desktop
// application asks it from its main process, with no port open (#64).

import type { Accounts, Session } from '../accounts/accounts.js';
import { outcomeOf, type AuditLog } from '../audit/audit.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  HttpError,
  matchPath,
  type AuditNote,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from './routes.js';

/** One call to the API, however it came. */
export interface Call {
  readonly method: string;
  /** The path asked for, without the query. */
  readonly pathname: string;
  readonly query: URLSearchParams;
  /** A header's value, by its lower-case name. */
  header(name: string): string | undefined;
  /** The body, read whole; rejects with a 413 {@link HttpError} when it is longer than `maxBytes`. */
  body(maxBytes: number): Promise<Uint8Array>;
}

/** What a call came to. */
export interface Dispatched {
  /**
   * For the log: the pattern of the route that was asked, or `unmatched`.
   * Never the address asked for: an address can carry identifiers, a
   * pattern cannot.
   */
  readonly route: string;
  /** The answer, a refusal or a failure included: nothing is thrown. */
  readonly answer: RouteResponse;
}

export interface DispatcherOptions {
  readonly routes: readonly Route[];
  /** Who may use the server; see `HostOptions.accounts`. */
  readonly accounts?: Accounts | null;
  /** Where it is written who did what; see `HostOptions.audit`. */
  readonly audit?: AuditLog | null;
  readonly logger?: Logger;
}

export interface Dispatcher {
  readonly routes: readonly Route[];
  /** The methods the routes at a path take; none when there is nothing there. */
  methodsAt(pathname: string): readonly string[];
  dispatch(call: Call): Promise<Dispatched>;
}

/** The token of an `Authorization: Bearer <token>` header; null for anything else. */
function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header?.trim() ?? '');
  return match ? match[1] : null;
}

/** A refusal as the answer it is. */
export function refusal(error: HttpError): RouteResponse {
  return {
    status: error.status,
    body: { error: error.code, message: error.message },
    headers: error.headers,
  };
}

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const { routes } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const accounts = options.accounts ?? null;
  const audit = options.audit ?? null;

  const at = (pathname: string) =>
    routes.flatMap((route) => {
      const params = matchPath(route.path, pathname);
      return params ? [{ route, params }] : [];
    });

  /**
   * Write the audit record of a call. False when it could not be written:
   * the call is then not answered, so that nothing leaves the server
   * without a record of who had it.
   */
  const recorded = (
    route: Route,
    params: Readonly<Record<string, string>>,
    session: Session | null,
    note: AuditNote,
    status: number,
  ): boolean => {
    if (!audit || route.audit === false) return true;
    const action = route.audit ?? 'request';
    // A route that says nothing of itself is known by its pattern and what stood in it.
    const unnamed = action === 'request';
    try {
      audit.record({
        actor: note.actor !== undefined ? note.actor : (session?.account.name ?? null),
        origin: 'api',
        action,
        outcome: outcomeOf(status),
        patientId: note.patientId ?? null,
        studyUid: note.studyUid ?? null,
        seriesUid: note.seriesUid ?? null,
        object: note.object ?? (unnamed ? `${route.method} ${route.path}` : null),
        detail:
          note.detail ??
          (unnamed && Object.keys(params).length > 0 ? JSON.stringify(params) : null),
      });
      return true;
    } catch (error) {
      logger.error('audit-failed', { route: route.path, ...errorFields(error) });
      return false;
    }
  };

  const internal = (): RouteResponse =>
    refusal(new HttpError(500, 'internal', 'The server could not answer.'));

  return {
    routes,

    methodsAt: (pathname) => at(pathname).map(({ route }) => route.method),

    async dispatch(call) {
      const onPath = at(call.pathname);
      if (onPath.length === 0) {
        return {
          route: 'unmatched',
          answer: refusal(new HttpError(404, 'not-found', 'There is nothing at this address.')),
        };
      }
      const match = onPath.find(({ route }) => route.method === call.method);
      if (!match) {
        const allow = onPath.map(({ route }) => route.method).join(', ');
        return {
          route: onPath[0].route.path,
          answer: refusal(
            new HttpError(405, 'method-not-allowed', 'This address does not take that method.', {
              Allow: allow,
            }),
          ),
        };
      }
      const { route, params } = match;
      // Who is asking. A token is looked at on a public route too, so that the
      // route can tell a logged-in caller; only its absence is let through there.
      let session: Session | null = null;
      let token: string | null = null;
      if (accounts) {
        token = bearerToken(call.header('authorization'));
        session = token === null ? null : accounts.authenticate(token);
        if (session === null) token = null;
        const access = route.access ?? 'user';
        if (access !== 'public' && session === null) {
          return {
            route: route.path,
            answer: refusal(
              new HttpError(401, 'unauthenticated', 'Log in to use this server.', {
                'WWW-Authenticate': 'Bearer',
              }),
            ),
          };
        }
        if (access === 'admin' && session?.account.role !== 'admin') {
          // Who tried what they may not is kept; the answer is the same whether it could be.
          recorded(route, params, session, {}, 403);
          return {
            route: route.path,
            answer: refusal(new HttpError(403, 'forbidden', 'This is for an administrator.')),
          };
        }
      }
      const note: AuditNote = {};
      const request: RouteRequest = {
        params,
        query: call.query,
        session,
        token,
        audit: (more) => void Object.assign(note, more),
        header: (name) => call.header(name),
        body: (maxBytes) => call.body(maxBytes),
      };
      let result: RouteResponse | null = null;
      let thrown: { readonly error: unknown } | null = null;
      try {
        result = await route.handle(request);
      } catch (error) {
        thrown = { error };
      }
      const status = result
        ? result.status
        : thrown?.error instanceof HttpError
          ? thrown.error.status
          : 500;
      if (!recorded(route, params, session, note, status)) {
        if (result && 'stream' in result) result.stream.destroy();
        return { route: route.path, answer: internal() };
      }
      if (result) return { route: route.path, answer: result };
      if (thrown?.error instanceof HttpError) {
        return { route: route.path, answer: refusal(thrown.error) };
      }
      // What went wrong is for the log; the caller is told only that it did.
      logger.error('route-failed', { route: route.path, ...errorFields(thrown?.error) });
      return { route: route.path, answer: internal() };
    },
  };
}
