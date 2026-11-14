/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCore, type ServerCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import { SERVER_VERSION } from '../version.js';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import { createHost, type HostOptions, type ServerHost } from './host.js';
import { HttpError, matchPath, type Route } from './routes.js';

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
    expect(await missing.json()).toEqual({
      error: 'not-found',
      message: 'There is nothing at this address.',
    });

    const posted = await fetch(`${url}/health`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
    expect(await posted.json()).toMatchObject({ error: 'method-not-allowed' });
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
    // The caller is told that it failed, and nothing of why.
    expect(await response.text()).toBe(
      '{"error":"internal","message":"The server could not answer."}',
    );
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

describe('routes', () => {
  it('names the parts of a path, decoded', async () => {
    const echo: Route = {
      method: 'GET',
      path: '/things/:kind/:name',
      handle: (request) => ({
        status: 200,
        body: { params: request.params, colour: request.query.get('colour') },
      }),
    };
    const { url, log } = await start({ routes: [echo] });
    const response = await fetch(`${url}/things/fruit/blood%20orange?colour=red`);
    expect(await response.json()).toEqual({
      params: { kind: 'fruit', name: 'blood orange' },
      colour: 'red',
    });
    expect((await fetch(`${url}/things/fruit`)).status).toBe(404);
    expect((await fetch(`${url}/things/fruit/`)).status).toBe(404);
    expect((await fetch(`${url}/things/fruit/a/b`)).status).toBe(404);
    // The log has the pattern, not what filled it.
    await vi.waitFor(() => expect(log().length).toBeGreaterThanOrEqual(1));
    expect(log()[0]).toMatchObject({ route: '/things/:kind/:name', status: 200 });
    expect(JSON.stringify(log())).not.toContain('orange');
  });

  it('matches a pattern part by part', () => {
    expect(matchPath('/a/:b/c', '/a/1.2.3/c')).toEqual({ b: '1.2.3' });
    expect(matchPath('/a/:b/c', '/a/x%2Fy/c')).toEqual({ b: 'x/y' });
    expect(matchPath('/a/:b/c', '/a//c')).toBeNull();
    expect(matchPath('/a/:b/c', '/a/1/d')).toBeNull();
    expect(matchPath('/a/:b', '/a/%ZZ')).toBeNull();
    expect(matchPath('/health', '/health')).toEqual({});
  });

  it('sends an HttpError a route throws as its status, code, message and headers', async () => {
    const teapot: Route = {
      method: 'GET',
      path: '/teapot',
      handle: () => {
        throw new HttpError(418, 'teapot', 'This is a teapot.', { 'Retry-After': '60' });
      },
    };
    const { url, log } = await start({ routes: [teapot] });
    const response = await fetch(`${url}/teapot`);
    expect(response.status).toBe(418);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: 'teapot', message: 'This is a teapot.' });
    // An answer the route chose is not a failure of the server.
    await vi.waitFor(() => expect(log()).toHaveLength(1));
    expect(log()[0]).toMatchObject({ event: 'request', status: 418 });
  });

  it('gives a route its body, up to the size the route allows', async () => {
    const size: Route = {
      method: 'POST',
      path: '/size',
      handle: async (request) => ({
        status: 200,
        body: {
          bytes: (await request.body(1000)).byteLength,
          type: request.header('content-type'),
        },
      }),
    };
    const { url } = await start({ routes: [size] });
    const post = (bytes: number) =>
      fetch(`${url}/size`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dicom' },
        body: new Uint8Array(bytes),
      });
    expect(await (await post(1000)).json()).toEqual({ bytes: 1000, type: 'application/dicom' });
    const tooLong = await post(1001);
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ error: 'too-large' });
  });

  it('counts a body that does not say how long it is', async () => {
    const size: Route = {
      method: 'POST',
      path: '/size',
      handle: async (request) => ({ status: 200, body: (await request.body(1000)).byteLength }),
    };
    const { url } = await start({ routes: [size] });
    // A stream has no Content-Length: the limit must hold as the bytes arrive.
    const send = (bytes: number) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${url}/size`, { method: 'POST' }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on('error', reject);
        Readable.from([Buffer.alloc(bytes / 2), Buffer.alloc(bytes / 2)]).pipe(request);
      });
    expect(await send(1000)).toBe(200);
    expect(await send(4000)).toBe(413);
  });

  it("streams what a route gives as a stream, with the route's headers", async () => {
    const stream: Route = {
      method: 'GET',
      path: '/stream',
      handle: () => ({
        status: 200,
        stream: Readable.from([Buffer.from('one '), Buffer.from('two')]),
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-cache' },
      }),
    };
    const { url } = await start({ routes: [stream] });
    const response = await fetch(`${url}/stream`);
    expect(await response.text()).toBe('one two');
    expect(response.headers.get('content-type')).toBe('text/plain');
    // The route's own caching rule stands; the default is no-store.
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('breaks off an answer whose stream fails part-way, and stays up', async () => {
    const broken: Route = {
      method: 'GET',
      path: '/broken',
      handle: () => ({
        status: 200,
        stream: Readable.from(
          (async function* () {
            yield Buffer.from('some');
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error('disk gone');
          })(),
        ),
        headers: { 'Content-Type': 'application/dicom', 'Content-Length': '1000' },
      }),
    };
    const { url, log } = await start({ routes: [broken] });
    await expect(
      fetch(`${url}/broken`).then((response) => response.arrayBuffer()),
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(log()).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'response-failed',
          errorMessage: 'disk gone',
        }),
      ),
    );
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});

describe('a server that listens on this machine only', () => {
  /** A request that says it is for `host`, whatever address it is sent to. */
  function addressedAs(url: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/health`, { headers: { Host: host } }, (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on('error', reject);
      request.end();
    });
  }

  it.each(['127.0.0.1', 'localhost', 'LOCALHOST:4300', '[::1]:4300', '127.0.0.1:1'])(
    'answers a request addressed to %s',
    async (host) => {
      const { url } = await start();
      expect((await addressedAs(url, host)).status).toBe(200);
    },
  );

  // A page elsewhere can point its own name at 127.0.0.1; the browser then
  // sends that name as the Host.
  it.each(['attacker.example', 'attacker.example:4300', '127.0.0.1.attacker.example'])(
    'refuses a request addressed to %j, which is some other name',
    async (host) => {
      const { url, log } = await start();
      const answer = await addressedAs(url, host);
      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body)).toMatchObject({ error: 'forbidden-host' });
      await vi.waitFor(() => expect(log()).toHaveLength(1));
      expect(log()[0]).toMatchObject({ route: 'forbidden-host', status: 403 });
      expect(JSON.stringify(log())).not.toContain('attacker');
    },
  );
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
