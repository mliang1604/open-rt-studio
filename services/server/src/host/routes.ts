/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Readable } from 'node:stream';

import type { Session } from '../accounts/accounts.js';
import type { ServerCore } from '../core/core.js';

/** What a route is asked with. */
export interface RouteRequest {
  /** The parts of the path that the route's pattern names, decoded: `{ studyUid: '1.2.3' }`. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** A request header's value, by its lower-case name. */
  header(name: string): string | undefined;
  /**
   * Whose request it is: the session of the token it came with. Null on a
   * server without accounts, and on a public route asked without a token.
   */
  readonly session: Session | null;
  /** The token the request came with, when it stands for a session. */
  readonly token: string | null;
  /**
   * The request's body, read whole. Rejects with a 413 {@link HttpError}
   * when it is longer than `maxBytes`.
   */
  body(maxBytes: number): Promise<Uint8Array>;
}

/** What a route answers with: JSON, or a stream of bytes with the headers that describe it. */
export type RouteResponse =
  | {
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly status: number;
      readonly stream: Readable;
      readonly headers: Readonly<Record<string, string>>;
    };

/** One parameter of a route, for the API description. */
export interface ParameterDoc {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly description: string;
  /** JSON Schema of the value; a string when left out. */
  readonly schema?: Readonly<Record<string, unknown>>;
}

/** What the API description says of a route. A route without this is not described. */
export interface RouteDoc {
  readonly summary: string;
  readonly description?: string;
  readonly tag: string;
  readonly parameters?: readonly ParameterDoc[];
  /** Media type of the request body, when the route takes one. */
  readonly requestBody?: string;
  /** Each status the route answers with: what it means, and the schema or media type of the body. */
  readonly responses: Readonly<
    Record<
      number,
      { readonly description: string; readonly schema?: string; readonly media?: string }
    >
  >;
}

/**
 * Who a route answers, on a server with accounts: anyone (`public`), whoever
 * is logged in (`user`), or an administrator (`admin`). A server without
 * accounts has one user, who is all of these.
 */
export type RouteAccess = 'public' | 'user' | 'admin';

/** One thing the server answers: a method on a path. */
export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * `user` when left out: a route is closed to whoever is not logged in
   * unless it says otherwise, so that a new route cannot be left open by
   * forgetting to say.
   */
  readonly access?: RouteAccess;
  /**
   * The path, matched whole. A part that begins with a colon stands for any
   * one part and names it: `/api/v1/studies/:studyUid/series`.
   */
  readonly path: string;
  handle(request: RouteRequest): RouteResponse | Promise<RouteResponse>;
  readonly doc?: RouteDoc;
}

/**
 * An answer that is an error: thrown by a route, sent by the host as
 * `{ "error": code, "message": ... }` with the status. The message is for the
 * caller and must not repeat what the caller sent.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

/**
 * Match a path against a route's pattern. The named parts, decoded, when it
 * matches; null when it does not, or when a part is not valid percent-encoding.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const wanted = pattern.split('/');
  const given = path.split('/');
  if (wanted.length !== given.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i].startsWith(':')) {
      if (given[i] === '') return null;
      try {
        params[wanted[i].slice(1)] = decodeURIComponent(given[i]);
      } catch {
        return null;
      }
    } else if (wanted[i] !== given[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Whether the server is up. 200 while it takes work; 503 once it is stopping,
 * so that whatever sends it requests stops sending them.
 */
export function healthRoute(core: ServerCore): Route {
  return {
    method: 'GET',
    path: '/health',
    // What watches the server (a container's health check) has no login.
    access: 'public',
    handle: () => {
      const health = core.health();
      return { status: health.status === 'ok' ? 200 : 503, body: health };
    },
    doc: {
      tag: 'Server',
      summary: 'Whether the server is up',
      responses: {
        200: { description: 'The server takes work.', schema: 'Health' },
        503: { description: 'The server is stopping.', schema: 'Health' },
      },
    },
  };
}
