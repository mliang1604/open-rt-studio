/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';

import type { Accounts, Session } from '../accounts/accounts.js';
import type { ServerCore } from '../core/core.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  healthRoute,
  HttpError,
  matchPath,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from './routes.js';

export interface HostOptions {
  readonly host: string;
  readonly port: number;
  /** How long closing waits for requests in flight before it cuts them off. */
  readonly shutdownTimeoutMs: number;
  readonly logger?: Logger;
  /** Routes besides the health endpoint. */
  readonly routes?: readonly Route[];
  /**
   * The web origins, besides the server's own, whose pages may call the
   * server from a browser. None by default.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Who may use the server. With accounts, a route answers only a request
   * that comes with the token of a login (a route marked `public` aside),
   * and an `admin` route only an administrator. Without, every request is
   * answered: for a server that only this machine can reach, and tests.
   */
  readonly accounts?: Accounts | null;
}

/** Where the host listens. */
export interface HostAddress {
  readonly host: string;
  readonly port: number;
}

/** What closing came to. */
export interface HostClosure {
  /** True when every request in flight was answered before the time ran out. */
  readonly finished: boolean;
  /** How many requests were cut off unanswered. */
  readonly cutOff: number;
}

/**
 * The network side of the server: HTTP on Node's own `node:http`, in front of
 * a {@link ServerCore}. This folder is the only code that knows about HTTP, so
 * the choice of how to serve it can change without touching the core
 * (docs/architecture.md, "Server and PACS").
 */
export interface ServerHost {
  /** Every route the host answers, the health endpoint first. */
  readonly routes: readonly Route[];
  /** Begin to listen. Resolves with the address, which names the port chosen for port 0. */
  listen(): Promise<HostAddress>;
  /**
   * Stop listening and let the requests in flight be answered, for at most
   * the shutdown timeout. Asking again gives the first answer.
   */
  close(): Promise<HostClosure>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** The names a browser on this machine reaches a loopback server by. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost']);

/** What a page of an allowed origin may send besides the plain headers. */
const CORS_REQUEST_HEADERS = 'Authorization, Content-Type, Range, If-None-Match';
/** What such a page may read of an answer besides the plain headers. */
const CORS_EXPOSED_HEADERS = 'ETag, Content-Range, Accept-Ranges, Content-Length, Location';

/** The token of an `Authorization: Bearer <token>` header; null for anything else. */
function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header?.trim() ?? '');
  return match ? match[1] : null;
}

/** The host of a `Host` header without its port: `[::1]:4300` gives `[::1]`. */
function hostName(header: string | undefined): string {
  return (header ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

export function createHost(core: ServerCore, options: HostOptions): ServerHost {
  const logger = options.logger ?? SILENT_LOGGER;
  const routes: readonly Route[] = [healthRoute(core), ...(options.routes ?? [])];
  /**
   * A server that listens on this machine only answers requests addressed to
   * this machine. A web page elsewhere can make its own name resolve to
   * 127.0.0.1 and so have the browser treat this server as its own origin;
   * such a request still carries the page's name in `Host`, and is refused.
   */
  const loopbackOnly = LOOPBACK_ADDRESSES.has(options.host);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const accounts = options.accounts ?? null;
  let inFlight = 0;
  let closing: Promise<HostClosure> | null = null;
  /** Called each time a request is answered while a close is waiting. */
  let onAnswered: (() => void) | null = null;

  const begin = (response: ServerResponse, status: number, headers: Record<string, string>) => {
    response.statusCode = status;
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    // What the server holds is not for a cache to keep, or a browser to guess the type of.
    if (!response.hasHeader('Cache-Control')) response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // A connection kept open would keep a stopping server from stopping.
    if (closing) response.setHeader('Connection', 'close');
  };

  const send = async (response: ServerResponse, answer: RouteResponse): Promise<void> => {
    if ('stream' in answer) {
      begin(response, answer.status, { ...answer.headers });
      // Ends the response when the stream ends, and both if either fails.
      await pipeline(answer.stream, response);
      return;
    }
    if (answer.status === 204) {
      // Done, with nothing to say: a 204 has no body.
      begin(response, 204, { ...answer.headers });
      response.end();
      return;
    }
    const text = JSON.stringify(answer.body);
    begin(response, answer.status, {
      'Content-Type': JSON_TYPE,
      'Content-Length': String(Buffer.byteLength(text)),
      ...answer.headers,
    });
    response.end(text);
  };

  const fail = (response: ServerResponse, error: HttpError): Promise<void> =>
    send(response, {
      status: error.status,
      body: { error: error.code, message: error.message },
      headers: error.headers,
    });

  const requestOf = (
    request: IncomingMessage,
    params: Record<string, string>,
    query: URLSearchParams,
    session: Session | null,
    token: string | null,
  ): RouteRequest => ({
    params,
    query,
    session,
    token,
    header: (name) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    },
    async body(maxBytes) {
      const tooLong = () =>
        new HttpError(413, 'too-large', `The body is longer than the ${maxBytes} bytes allowed.`);
      if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw tooLong();
      const pieces: Buffer[] = [];
      let size = 0;
      for await (const piece of request) {
        size += (piece as Buffer).byteLength;
        if (size > maxBytes) throw tooLong();
        pieces.push(piece as Buffer);
      }
      return Buffer.concat(pieces);
    },
  });

  /** Answer one request; says which route it was, for the log. */
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<string> => {
    if (loopbackOnly && !LOOPBACK_NAMES.has(hostName(request.headers.host))) {
      await fail(
        response,
        new HttpError(
          403,
          'forbidden-host',
          'This server answers only when addressed as this machine.',
        ),
      );
      return 'forbidden-host';
    }
    // A browser names the page a request comes from. Without that name the
    // caller is not a page (a script, the desktop application), and passes.
    // With it, the page must be the server's own or one that was allowed:
    // a page elsewhere must not get the server to do anything, read or not.
    const origin = request.headers.origin?.toLowerCase();
    if (origin !== undefined) {
      const own = origin.replace(/^https?:\/\//, '') === request.headers.host?.toLowerCase();
      if (!own && !allowedOrigins.has(origin)) {
        await fail(
          response,
          new HttpError(
            403,
            'forbidden-origin',
            'This server does not answer pages of that origin.',
          ),
        );
        return 'forbidden-origin';
      }
      if (!own) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
      }
    }
    // The answer depends on who asked: a cache must not give one page's to another.
    if (allowedOrigins.size > 0) response.setHeader('Vary', 'Origin');
    let url: URL;
    try {
      url = new URL(request.url ?? '', 'http://host');
    } catch {
      await fail(response, new HttpError(400, 'bad-request', 'The address could not be read.'));
      return 'unreadable';
    }
    const onPath = routes.flatMap((route) => {
      const params = matchPath(route.path, url.pathname);
      return params ? [{ route, params }] : [];
    });
    if (onPath.length === 0) {
      await fail(response, new HttpError(404, 'not-found', 'There is nothing at this address.'));
      return 'unmatched';
    }
    // A browser asking, before the real request, whether it may send it.
    if (
      request.method === 'OPTIONS' &&
      origin !== undefined &&
      request.headers['access-control-request-method'] !== undefined
    ) {
      begin(response, 204, {
        'Access-Control-Allow-Methods': onPath.map(({ route }) => route.method).join(', '),
        'Access-Control-Allow-Headers': CORS_REQUEST_HEADERS,
        'Access-Control-Max-Age': '600',
        // Chrome asks this of a public page that calls a server on a private
        // network or on this machine.
        ...(request.headers['access-control-request-private-network'] === 'true'
          ? { 'Access-Control-Allow-Private-Network': 'true' }
          : {}),
      });
      response.end();
      return 'preflight';
    }
    const match = onPath.find(({ route }) => route.method === request.method);
    if (!match) {
      const allow = onPath.map(({ route }) => route.method).join(', ');
      await fail(
        response,
        new HttpError(405, 'method-not-allowed', 'This address does not take that method.', {
          Allow: allow,
        }),
      );
      return onPath[0].route.path;
    }
    const { route, params } = match;
    // Who is asking. A token is looked at on a public route too, so that the
    // route can tell a logged-in caller; only its absence is let through there.
    let session: Session | null = null;
    let token: string | null = null;
    if (accounts) {
      token = bearerToken(request.headers.authorization);
      session = token === null ? null : accounts.authenticate(token);
      if (session === null) token = null;
      const access = route.access ?? 'user';
      if (access !== 'public' && session === null) {
        await fail(
          response,
          new HttpError(401, 'unauthenticated', 'Log in to use this server.', {
            'WWW-Authenticate': 'Bearer',
          }),
        );
        return route.path;
      }
      if (access === 'admin' && session?.account.role !== 'admin') {
        await fail(response, new HttpError(403, 'forbidden', 'This is for an administrator.'));
        return route.path;
      }
    }
    try {
      await send(
        response,
        await route.handle(requestOf(request, params, url.searchParams, session, token)),
      );
    } catch (error) {
      if (response.headersSent) {
        // Part of an answer is out already; the rest cannot be taken back.
        logger.error('response-failed', { route: route.path, ...errorFields(error) });
        response.destroy();
      } else if (error instanceof HttpError) {
        // A refused upload may still be arriving: do not keep the connection for it.
        if (error.status === 413) response.setHeader('Connection', 'close');
        await fail(response, error);
      } else {
        // What went wrong is for the log; the caller is told only that it did.
        logger.error('route-failed', { route: route.path, ...errorFields(error) });
        await fail(response, new HttpError(500, 'internal', 'The server could not answer.'));
      }
    }
    return route.path;
  };

  const server = createServer((request, response) => {
    const began = performance.now();
    inFlight++;
    let counted = true;
    const ended = (): void => {
      if (!counted) return;
      counted = false;
      inFlight--;
      onAnswered?.();
    };
    // 'close' comes whether the response was sent or the caller went away.
    response.once('close', ended);
    void answer(request, response)
      .catch((error: unknown) => {
        logger.error('response-failed', errorFields(error));
        response.destroy();
        return 'failed';
      })
      .then((route) => {
        // The route's own pattern, never the address asked for: an address
        // can carry identifiers, a pattern cannot.
        logger.info('request', {
          method: request.method,
          route,
          status: response.statusCode,
          ms: Math.round(performance.now() - began),
        });
      });
  });

  return {
    routes,

    listen: () =>
      new Promise<HostAddress>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      }),

    close() {
      closing ??= new Promise<HostClosure>((resolve) => {
        let cutOff = 0;
        const timer = setTimeout(() => {
          cutOff = inFlight;
          if (cutOff > 0) logger.warn('requests-cut-off', { count: cutOff });
          server.closeAllConnections();
        }, options.shutdownTimeoutMs);
        // Resolves when the last connection is gone.
        server.close(() => {
          clearTimeout(timer);
          onAnswered = null;
          resolve({ finished: cutOff === 0, cutOff });
        });
        // After the answer is on its way: a connection counts as idle only
        // once its response has been written out.
        const drained = (): void => {
          if (inFlight === 0) setImmediate(() => server.closeIdleConnections());
        };
        onAnswered = drained;
        drained();
      });
      return closing;
    },
  };
}
