/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ServerCore } from '../core/core.js';

/** What a route answers with: a status and a body sent as JSON. */
export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One thing the server answers: a method on an exact path. */
export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** The path, matched whole: `/health`. */
  readonly path: string;
  handle(): RouteResponse | Promise<RouteResponse>;
}

/**
 * Whether the server is up. 200 while it takes work; 503 once it is stopping,
 * so that whatever sends it requests stops sending them.
 */
export function healthRoute(core: ServerCore): Route {
  return {
    method: 'GET',
    path: '/health',
    handle: () => {
      const health = core.health();
      return { status: health.status === 'ok' ? 200 : 503, body: health };
    },
  };
}
