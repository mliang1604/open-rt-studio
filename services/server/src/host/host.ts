/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ServerCore } from '../core/core.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import { healthRoute, type Route, type RouteResponse } from './routes.js';

export interface HostOptions {
  readonly host: string;
  readonly port: number;
  /** How long closing waits for requests in flight before it cuts them off. */
  readonly shutdownTimeoutMs: number;
  readonly logger?: Logger;
  /** Routes besides the health endpoint. */
  readonly routes?: readonly Route[];
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
  /** Begin to listen. Resolves with the address, which names the port chosen for port 0. */
  listen(): Promise<HostAddress>;
  /**
   * Stop listening and let the requests in flight be answered, for at most
   * the shutdown timeout. Asking again gives the first answer.
   */
  close(): Promise<HostClosure>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function createHost(core: ServerCore, options: HostOptions): ServerHost {
  const logger = options.logger ?? SILENT_LOGGER;
  const routes: readonly Route[] = [healthRoute(core), ...(options.routes ?? [])];
  let inFlight = 0;
  let closing: Promise<HostClosure> | null = null;
  /** Called each time a request is answered while a close is waiting. */
  let onAnswered: (() => void) | null = null;

  const send = (
    response: ServerResponse,
    { status, body }: RouteResponse,
    allow?: string,
  ): void => {
    const text = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', JSON_TYPE);
    response.setHeader('Content-Length', Buffer.byteLength(text));
    response.setHeader('Cache-Control', 'no-store');
    if (allow) response.setHeader('Allow', allow);
    // A connection kept open would keep a stopping server from stopping.
    if (closing) response.setHeader('Connection', 'close');
    response.end(text);
  };

  /** Answer one request; says which route it was, for the log. */
  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<string> => {
    let path: string;
    try {
      path = new URL(request.url ?? '', 'http://host').pathname;
    } catch {
      send(response, { status: 400, body: { error: 'bad-request' } });
      return 'unreadable';
    }
    const onPath = routes.filter((route) => route.path === path);
    if (onPath.length === 0) {
      send(response, { status: 404, body: { error: 'not-found' } });
      return 'unmatched';
    }
    const route = onPath.find((candidate) => candidate.method === request.method);
    if (!route) {
      const allow = onPath.map((candidate) => candidate.method).join(', ');
      send(response, { status: 405, body: { error: 'method-not-allowed' } }, allow);
      return path;
    }
    try {
      send(response, await route.handle());
    } catch (error) {
      // What went wrong is for the log; the caller is told only that it did.
      logger.error('route-failed', { route: path, ...errorFields(error) });
      send(response, { status: 500, body: { error: 'internal' } });
    }
    return path;
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
    void answer(request, response).then((route) => {
      // The route's own path, never the address asked for: an address can
      // carry identifiers, a route cannot.
      logger.info('request', {
        method: request.method,
        route,
        status: response.statusCode,
        ms: Math.round(performance.now() - began),
      });
    });
  });

  return {
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
