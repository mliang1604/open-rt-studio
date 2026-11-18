/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A server from the desktop application (#63). There the page has no
// network: its requests to a server go through the bridge to the main
// process, which sends them, and only to a server the user agreed to in a
// dialog of the main process.
//
// The rest of the application does not know. `ServerSource` asks with a
// `fetch` it is given; here that is one that asks through the bridge and
// gives back the server's answer as a `Response`.
//
// The login differs in one way. Its token stays in the main process, which
// adds it to what is sent and keeps it, protected by the system, across
// runs. The page holds a marker in its place, so that it knows it is logged
// in and has nothing that could be taken from it.

import { InjectionToken } from '@angular/core';
import {
  desktopBridge,
  HELD_LOGIN,
  SERVER_REQUEST_HEADERS,
  type DesktopServer,
  type ServerConnection,
  type ServerFailure,
  type ServerMethod,
} from '@open-rt-studio/desktop-bridge';

import { connectToServer, serverAddress, type ServerSource } from './data-source/server-source';

/** The bridge's server calls; null in a browser. Replaced in tests. */
export const DESKTOP_SERVER = new InjectionToken<DesktopServer | null>('desktop server', {
  providedIn: 'root',
  factory: () => desktopBridge()?.server ?? null,
});

/** A request the main process could not get answered. A `TypeError`, as a failed `fetch` is. */
export class DesktopFetchError extends TypeError {
  constructor(readonly reason: ServerFailure | 'forgotten') {
    super(`The request was not answered (${reason}).`);
    this.name = 'DesktopFetchError';
  }
}

/** A name for a request, of the form the main process takes: 22 characters of 128 random bits. */
function requestName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const aborted = (): DOMException => new DOMException('The request was given up.', 'AbortError');

/**
 * A `fetch` for one connection: it takes what `ServerSource` asks of the
 * server's address and asks it through the bridge. Who is asking is not
 * said here: the main process adds the login it holds.
 */
export function desktopFetch(server: DesktopServer, connection: ServerConnection): typeof fetch {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${connection.address}/`)) throw new DesktopFetchError('unreachable');
    const signal = init.signal ?? null;
    if (signal?.aborted) throw aborted();

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((text, name) => {
      if ((SERVER_REQUEST_HEADERS as readonly string[]).includes(name)) headers[name] = text;
    });
    const body =
      init.body === undefined || init.body === null
        ? null
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    const request = requestName();
    const asked = server.request(connection.id, {
      request,
      method: (init.method ?? 'GET').toUpperCase() as ServerMethod,
      path: url.slice(connection.address.length),
      headers,
      body,
    });
    // Given up: the page is told at once, and the main process stops the request.
    const answer = await (signal === null
      ? asked
      : Promise.race([
          asked,
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                void server.cancel(request);
                reject(aborted());
              },
              { once: true },
            );
          }),
        ]));
    if (answer === null) throw new DesktopFetchError('forgotten');
    if ('failed' in answer) {
      throw answer.failed === 'cancelled' ? aborted() : new DesktopFetchError(answer.failed);
    }
    // An answer of these sorts has no body, and a `Response` refuses one.
    const empty = [204, 205, 304].includes(answer.status) || answer.body.byteLength === 0;
    return new Response(empty ? null : new Uint8Array(answer.body), {
      status: answer.status,
      headers: answer.headers,
    });
  };
}

/** Why a server was not reached, as the desktop application can tell it. */
export function desktopUnreachable(host: string, error: unknown): string {
  const reason = error instanceof DesktopFetchError ? error.reason : 'unreachable';
  switch (reason) {
    case 'certificate':
      return `The server at ${host} was not connected to: this computer does not trust its certificate.`;
    case 'too-large':
      return `The server at ${host} sent more than the application takes in one answer.`;
    case 'forgotten':
      return `The server at ${host} is no longer one of the saved servers. Connect to it again.`;
    case 'unreachable':
    case 'cancelled':
      return `The server at ${host} could not be reached. It may not be running, or its address may be another.`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The user said no to the server, in the main process's dialog. */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected: the server was not agreed to.');
    this.name = 'NotConnectedError';
  }
}

/**
 * How the desktop application reaches a server: the main process is asked to
 * connect, which asks the user about a server it does not know, and the
 * source is made over the bridge. A login the application holds is used.
 */
export function desktopConnector(server: DesktopServer): (typed: string) => Promise<ServerSource> {
  return async (typed) => {
    // What is no address is said to be none here, before anyone is asked about it.
    const connection = await server.connect(serverAddress(typed));
    if (connection === null) throw new NotConnectedError();
    return connectToServer(connection.address, {
      fetch: desktopFetch(server, connection),
      token: connection.loggedIn ? HELD_LOGIN : null,
      unreachable: desktopUnreachable,
    });
  };
}
