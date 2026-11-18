/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for the main process's server calls, for specs: it sends what
// it is asked to a `fetch` it is given (a stand-in server's), and holds the
// token of a login as the main process does.

import {
  HELD_LOGIN,
  type DesktopServer,
  type ServerAnswer,
  type ServerConnection,
  type ServerFailure,
  type ServerRequest,
} from '@open-rt-studio/desktop-bridge';

export interface FakeDesktopServer extends DesktopServer {
  /** Whether the user agrees to a server they are asked about. */
  agrees: boolean;
  /** The addresses the user was asked about. */
  readonly asked: string[];
  /** Every request, as the page made it. */
  readonly requests: ServerRequest[];
  /** The requests the page gave up. */
  readonly cancelled: string[];
  /** From now on, answer every request with this failure; null to answer again. */
  failing: ServerFailure | null;
  /** The token held for a connection, by its id. */
  readonly tokens: Map<string, string>;
}

const SESSION = '/api/v1/session';

export function fakeDesktopServer(fetcher: typeof fetch): FakeDesktopServer {
  const saved: { id: string; address: string }[] = [];
  const tokens = new Map<string, string>();
  const told = ({ id, address }: { id: string; address: string }): ServerConnection => ({
    id,
    address,
    loggedIn: tokens.has(id),
  });
  const fake: FakeDesktopServer = {
    agrees: true,
    asked: [],
    requests: [],
    cancelled: [],
    failing: null,
    tokens,
    connect: async (address) => {
      let connection = saved.find((one) => one.address === address);
      if (!connection) {
        fake.asked.push(address);
        if (!fake.agrees) return null;
        connection = { id: `connection-${saved.length + 1}`.padEnd(22, '0'), address };
        saved.unshift(connection);
      }
      return told(connection);
    },
    connections: async () => saved.map(told),
    forget: async (id) => {
      const at = saved.findIndex((one) => one.id === id);
      if (at >= 0) saved.splice(at, 1);
      tokens.delete(id);
      return null;
    },
    request: async (id, request): Promise<ServerAnswer | null> => {
      fake.requests.push(request);
      const connection = saved.find((one) => one.id === id);
      if (!connection) return null;
      if (fake.failing) return { failed: fake.failing };
      const token = tokens.get(id);
      let response: Response;
      try {
        response = await fetcher(`${connection.address}${request.path}`, {
          method: request.method,
          headers: { ...request.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          // The stand-in server reads JSON as the text a page sends it.
          body:
            request.body === null
              ? undefined
              : request.headers['content-type'] === 'application/json'
                ? new TextDecoder().decode(request.body)
                : new Uint8Array(request.body),
        });
      } catch {
        return { failed: 'unreachable' };
      }
      let body = new Uint8Array(await response.arrayBuffer());
      if (request.path === SESSION && request.method === 'DELETE') tokens.delete(id);
      if (request.path === SESSION && request.method === 'POST' && response.ok) {
        const said = JSON.parse(new TextDecoder().decode(body)) as { token?: string };
        if (typeof said.token === 'string') {
          tokens.set(id, said.token);
          body = new TextEncoder().encode(JSON.stringify({ ...said, token: HELD_LOGIN }));
        }
      }
      if (response.status === 401 && token) tokens.delete(id);
      const headers: Record<string, string> = {};
      response.headers.forEach((text, name) => (headers[name] = text));
      return { status: response.status, headers, body };
    },
    cancel: async (request) => {
      fake.cancelled.push(request);
      return null;
    },
  };
  return fake;
}
