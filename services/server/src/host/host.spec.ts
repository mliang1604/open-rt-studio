/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCore, type ServerCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import { SERVER_VERSION } from '../version.js';
import { createHost, type HostOptions, type ServerHost } from './host.js';
import type { Route } from './routes.js';

interface Started {
  readonly core: ServerCore;
  readonly host: ServerHost;
  readonly url: string;
  /** The log, one parsed line each. */
  readonly log: () => Record<string, unknown>[];
}

const open: ServerHost[] = [];

/** A host on a free port of this machine. */
async function start(options: Partial<HostOptions> = {}): Promise<Started> {
  const lines: string[] = [];
  const core = createCore();
  const host = createHost(core, {
    host: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs: 2_000,
    logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    ...options,
  });
  open.push(host);
  const address = await host.listen();
  return {
    core,
    host,
    url: `http://127.0.0.1:${address.port}`,
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A route that answers when the test says so. */
function slowRoute() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const begun = new Promise<void>((resolve) => (entered = resolve));
  const route: Route = {
    method: 'GET',
    path: '/slow',
    handle: async () => {
      entered();
      await released;
      return { status: 200, body: { done: true } };
    },
  };
  return { route, release, begun };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((host) => host.close()));
});

describe('createHost', () => {
  it('answers the health endpoint', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ok',
      version: SERVER_VERSION,
      uptimeSeconds: 0,
      inFlight: 0,
    });
  });

  it('says 503 on the health endpoint once the core is stopping', async () => {
    const { core, url } = await start();
    await core.dispose();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'stopping' });
  });

  it('answers 404 to a path it does not have, and 405 to a method a path does not take', async () => {
    const { url } = await start();
    const missing = await fetch(`${url}/nothing-here`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not-found' });

    const posted = await fetch(`${url}/health`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
    expect(await posted.json()).toEqual({ error: 'method-not-allowed' });
  });

  it('matches the path alone: a query does not change the route', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/health?verbose=1`)).status).toBe(200);
    expect((await fetch(`${url}/health/`)).status).toBe(404);
  });

  it('logs the route, never the address that was asked for', async () => {
    const { url, log } = await start();
    await fetch(`${url}/health?patient=SYN-0001`);
    await fetch(`${url}/patients/SYN-0001/studies`);
    await vi.waitFor(() => expect(log()).toHaveLength(2));
    expect(log()).toMatchObject([
      { event: 'request', method: 'GET', route: '/health', status: 200 },
      { event: 'request', method: 'GET', route: 'unmatched', status: 404 },
    ]);
    expect(JSON.stringify(log())).not.toContain('SYN-0001');
  });

  it('answers 500 when a route fails, and keeps what failed for the log', async () => {
    const failing: Route = {
      method: 'GET',
      path: '/fails',
      handle: () => Promise.reject(new Error('index is locked')),
    };
    const { url, log } = await start({ routes: [failing] });
    const response = await fetch(`${url}/fails`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    await vi.waitFor(() => expect(log()).toHaveLength(2));
    expect(log()[0]).toMatchObject({
      level: 'error',
      event: 'route-failed',
      route: '/fails',
      errorMessage: 'index is locked',
    });
    // The server is still up.
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('says so when the port is taken', async () => {
    const first = await start();
    const port = Number(new URL(first.url).port);
    const second = createHost(createCore(), { host: '127.0.0.1', port, shutdownTimeoutMs: 100 });
    await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('closing the host', () => {
  it('lets a request in flight be answered, and takes no new connection', async () => {
    const slow = slowRoute();
    const { host, url } = await start({ routes: [slow.route] });
    const inFlight = fetch(`${url}/slow`);
    await slow.begun;

    let closed = false;
    const closing = host.close().then((closure) => {
      closed = true;
      return closure;
    });
    // Not closed while the request is unanswered; and nobody new gets in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    await expect(fetch(`${url}/health`)).rejects.toThrow();

    slow.release();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(response.headers.get('connection')).toBe('close');
    expect(await response.json()).toEqual({ done: true });
    expect(await closing).toEqual({ finished: true, cutOff: 0 });
  });

  it('closes at once when nothing is in flight, even with a connection kept open', async () => {
    const { host, url } = await start();
    // fetch keeps its connection open for the next request.
    await (await fetch(`${url}/health`)).text();
    const began = performance.now();
    expect(await host.close()).toEqual({ finished: true, cutOff: 0 });
    expect(performance.now() - began).toBeLessThan(1_000);
  });

  it('cuts off a request that outlasts the timeout, and says how many', async () => {
    const slow = slowRoute();
    const { host, url, log } = await start({ routes: [slow.route], shutdownTimeoutMs: 40 });
    const inFlight = fetch(`${url}/slow`);
    await slow.begun;

    expect(await host.close()).toEqual({ finished: false, cutOff: 1 });
    await expect(inFlight).rejects.toThrow();
    expect(log()).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'requests-cut-off', count: 1 }),
    );
    slow.release();
  });

  it('answers a second close with the first, and closes a host that never listened', async () => {
    const { host } = await start();
    const first = host.close();
    expect(host.close()).toBe(first);
    expect(await first).toEqual({ finished: true, cutOff: 0 });

    const never = createHost(createCore(), { host: '127.0.0.1', port: 0, shutdownTimeoutMs: 100 });
    expect(await never.close()).toEqual({ finished: true, cutOff: 0 });
  });
});
