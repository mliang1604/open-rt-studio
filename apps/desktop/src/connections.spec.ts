/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HELD_LOGIN, type ServerAnswer, type ServerRequest } from '@open-rt-studio/desktop-bridge';

import {
  isPlain,
  openConnections,
  sealWhenNeeded,
  serverOrigin,
  type ConnectionsOptions,
  type Seal,
} from './connections.js';

const ADDRESS = 'https://pacs.example.org';
const TOKEN = 'the-token-of-the-login-0123456789';
const REQUEST = 'Zm9sZGVyLW9mLXRlc3RzIQ';

let scratch: string;
let file: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-connections-'));
  file = join(scratch, 'profile', 'server-connections.json');
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A seal that can be told from the text it sealed, and opens only its own. */
const SEAL: Seal = {
  seal: (text) => `sealed<${[...text].reverse().join('')}>`,
  open: (sealed) =>
    /^sealed<.*>$/.test(sealed) ? [...sealed.slice(7, -1)].reverse().join('') : null,
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly redirect: string | undefined;
}

/** A server: it answers a login with the token, and everything else as `answer` says. */
function serverWith(
  answer: (sent: Sent) => Response | Promise<Response> = () => json({ ok: true }),
) {
  const sent: Sent[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const one: Sent = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? new TextDecoder().decode(init.body as Uint8Array) : null,
      redirect: init.redirect,
    };
    sent.push(one);
    return answer(one);
  };
  return { sent, fetcher };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const asked: { address: string; plain: boolean }[] = [];
beforeEach(() => {
  asked.length = 0;
});

function connectionsWith(fetcher: typeof fetch, more: Partial<ConnectionsOptions> = {}) {
  return openConnections({
    file,
    fetch: fetcher,
    approve: async (address, plain) => {
      asked.push({ address, plain });
      return true;
    },
    seal: SEAL,
    ...more,
  });
}

const request = (more: Partial<ServerRequest> = {}): ServerRequest => ({
  request: REQUEST,
  method: 'GET',
  path: '/api/v1/patients',
  headers: {},
  body: null,
  ...more,
});
const login = (): ServerRequest =>
  request({
    method: 'POST',
    path: '/api/v1/session',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ name: 'ada', password: 'a password' })),
  });
/** A server that knows one login, and asks for it. */
const withLogin = () =>
  serverWith((sent) => {
    if (sent.url.endsWith('/api/v1/session') && sent.method === 'POST') {
      return json({ token: TOKEN, account: { name: 'ada', role: 'admin' } });
    }
    return sent.headers['authorization'] === `Bearer ${TOKEN}`
      ? json({ items: [] })
      : json({ error: 'unauthorized' }, 401);
  });

const said = (answer: ServerAnswer | null): unknown => {
  if (answer === null || 'failed' in answer) return answer;
  return JSON.parse(new TextDecoder().decode(answer.body));
};
const kept = async (): Promise<string> => readFile(file, 'utf8');

describe('the address of a server', () => {
  it('is its origin, over http or https', () => {
    expect(serverOrigin('https://pacs.example.org')).toBe('https://pacs.example.org');
    expect(serverOrigin(' https://PACS.example.org:8443/viewer?x=1#y ')).toBe(
      'https://pacs.example.org:8443',
    );
    expect(serverOrigin('127.0.0.1:4300')).toBe('http://127.0.0.1:4300');
    expect(serverOrigin('localhost:4300/')).toBe('http://localhost:4300');
  });

  it('is nothing else', () => {
    for (const wrong of [
      '',
      '   ',
      'not an address',
      'file:///etc/passwd',
      'ftp://pacs.example.org',
      'javascript:alert(1)',
      'app://open-rt-studio/',
      'https://ada:secret@pacs.example.org',
      'https://ada@pacs.example.org',
      'https://',
      `https://${'a'.repeat(3000)}.example.org`,
    ]) {
      expect(serverOrigin(wrong), wrong.slice(0, 40)).toBeNull();
    }
  });

  it('is plain when what is sent can be read on the way', () => {
    expect(isPlain('http://pacs.example.org')).toBe(true);
    expect(isPlain('http://192.168.1.20:4300')).toBe(true);
    expect(isPlain('https://pacs.example.org')).toBe(false);
    expect(isPlain('http://127.0.0.1:4300')).toBe(false);
    expect(isPlain('http://localhost:4300')).toBe(false);
    expect(isPlain('http://[::1]:4300')).toBe(false);
  });
});

describe('connecting to a server', () => {
  it('asks the user about a server it does not know, once, and sends nothing to ask', async () => {
    const { sent, fetcher } = serverWith();
    const connections = await connectionsWith(fetcher);
    const connection = (await connections.connect(` ${ADDRESS}/ `))!;
    expect(connection).toEqual({ id: connection.id, address: ADDRESS, loggedIn: false });
    expect(asked).toEqual([{ address: ADDRESS, plain: false }]);
    // The same server, however it is typed, is one connection, and is not asked about again.
    expect((await connections.connect('HTTPS://pacs.example.org'))!.id).toBe(connection.id);
    expect(asked).toHaveLength(1);
    expect(sent).toEqual([]);

    // Over http to another machine, the user is told what that means.
    await connections.connect('http://pacs.example.org:4300');
    expect(asked[1]).toEqual({ address: 'http://pacs.example.org:4300', plain: true });
    expect(connections.list().map((one) => one.address)).toEqual([
      'http://pacs.example.org:4300',
      ADDRESS,
    ]);
  });

  it('connects to nothing the user refuses, and does not ask about what is no address', async () => {
    const { sent, fetcher } = serverWith();
    const connections = await connectionsWith(fetcher, {
      approve: async (address, plain) => {
        asked.push({ address, plain });
        return false;
      },
    });
    expect(await connections.connect(ADDRESS)).toBeNull();
    expect(await connections.connect('file:///etc/passwd')).toBeNull();
    expect(await connections.connect('')).toBeNull();
    expect(asked).toEqual([{ address: ADDRESS, plain: false }]);
    expect(connections.list()).toEqual([]);
    expect(sent).toEqual([]);
    await expect(kept()).rejects.toThrow();
  });

  it('remembers the servers for the next run, and only so many', async () => {
    let clock = 0;
    const { fetcher } = serverWith();
    const options = { savedAtMost: 2, now: () => (clock += 1) };
    const first = await connectionsWith(fetcher, options);
    const a = (await first.connect('https://a.example.org'))!;
    const b = (await first.connect('https://b.example.org'))!;
    await first.connect('https://a.example.org');
    await first.connect('https://c.example.org');
    // The one unused longest went.
    expect(first.list().map((one) => one.address)).toEqual([
      'https://c.example.org',
      'https://a.example.org',
    ]);

    asked.length = 0;
    const next = await connectionsWith(fetcher, options);
    expect((await next.connect('https://a.example.org'))!.id).toBe(a.id);
    expect(asked).toEqual([]);
    // What was let go is a server the user is asked about again.
    expect((await next.connect('https://b.example.org'))!.id).not.toBe(b.id);
    expect(asked).toHaveLength(1);

    await next.forget(a.id);
    expect((await connectionsWith(fetcher)).list().map((one) => one.address)).not.toContain(
      'https://a.example.org',
    );
  });

  it('starts from nothing when its file cannot be read, and takes nothing wrong from it', async () => {
    const { fetcher } = serverWith();
    await (await connectionsWith(fetcher)).connect(ADDRESS);
    await writeFile(file, '{ not json');
    expect((await connectionsWith(fetcher)).list()).toEqual([]);
    for (const wrong of [
      { id: REQUEST, address: 'file:///etc/passwd', used: 1 },
      { id: REQUEST, address: 'https://pacs.example.org/path', used: 1 },
      { id: '../x', address: ADDRESS, used: 1 },
      { id: REQUEST, address: ADDRESS },
      { id: REQUEST, address: ADDRESS, used: 1, login: 7 },
    ]) {
      await writeFile(file, JSON.stringify({ version: 1, connections: [wrong] }));
      expect((await connectionsWith(fetcher)).list(), JSON.stringify(wrong)).toEqual([]);
    }
  });
});

describe("asking a server's API", () => {
  it('sends what the page asks to the server that was agreed to, and gives its answer whole', async () => {
    const { sent, fetcher } = serverWith(() =>
      json({ items: [1, 2] }, 200, { ETag: '"abc"', 'Set-Cookie': 'session=1' }),
    );
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    const answer = await connections.request(
      id,
      request({
        method: 'POST',
        path: '/api/v1/instances?overwrite=1',
        headers: { 'content-type': 'application/dicom' },
        body: new TextEncoder().encode('bytes'),
      }),
    );
    expect(sent).toEqual([
      {
        url: `${ADDRESS}/api/v1/instances?overwrite=1`,
        method: 'POST',
        headers: { 'content-type': 'application/dicom' },
        body: 'bytes',
        // A server that sends the application elsewhere is not followed.
        redirect: 'error',
      },
    ]);
    expect(answer).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"abc"' },
    });
    expect(said(answer)).toEqual({ items: [1, 2] });
    // Nothing that would set a login in the page.
    expect(Object.keys((answer as { headers: object }).headers)).not.toContain('set-cookie');
  });

  it('gives the status of a refusal as the answer it is', async () => {
    const { fetcher } = serverWith(() => json({ message: 'no such patient' }, 404));
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    const answer = await connections.request(id, request());
    expect(answer).toMatchObject({ status: 404 });
    expect(said(answer)).toEqual({ message: 'no such patient' });
  });

  it('asks nothing of a server that was not agreed to, and nothing outside the API', async () => {
    const { sent, fetcher } = serverWith();
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    expect(await connections.request('bm90LWEtY29ubmVjdGlvbg', request())).toBeNull();
    for (const path of [
      '/health',
      '/api/v1/../../health',
      '//elsewhere.example/api/v1/session',
      'https://elsewhere.example/api/v1/session',
      '/api/v1/a\\..\\b',
    ]) {
      expect(await connections.request(id, request({ path })), path).toBeNull();
    }
    expect(
      await connections.request(
        id,
        request({ headers: { authorization: 'Bearer of-the-page' } as Record<string, string> }),
      ),
    ).toBeNull();
    await connections.forget(id);
    expect(await connections.request(id, request())).toBeNull();
    expect(sent).toEqual([]);
  });

  it('says why a server did not answer, and no more', async () => {
    const failing = (error: unknown) =>
      connectionsWith(() => Promise.reject(error)).then(async (connections) => {
        const { id } = (await connections.connect(ADDRESS))!;
        return connections.request(id, request());
      });
    expect(await failing(new TypeError('fetch failed'))).toEqual({ failed: 'unreachable' });
    expect(await failing(new Error('net::ERR_CONNECTION_REFUSED'))).toEqual({
      failed: 'unreachable',
    });
    expect(await failing(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toEqual({
      failed: 'certificate',
    });
    expect(
      await failing(new TypeError('fetch failed', { cause: new Error('self-signed certificate') })),
    ).toEqual({ failed: 'certificate' });
    expect(await failing('not even an error')).toEqual({ failed: 'unreachable' });
  });

  it('takes no answer larger than its limit, whether the server says so or not', async () => {
    const large = new Uint8Array(2000);
    for (const headers of [{ 'Content-Length': '2000' }, {}] as Record<string, string>[]) {
      const { fetcher } = serverWith(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(large.slice(0, 1000));
                controller.enqueue(large.slice(1000));
                controller.close();
              },
            }),
            { headers },
          ),
      );
      const connections = await connectionsWith(fetcher, { answerBytesAtMost: 1500 });
      const { id } = (await connections.connect(ADDRESS))!;
      expect(await connections.request(id, request())).toEqual({ failed: 'too-large' });
    }
  });

  it('gives up a request that is cancelled', async () => {
    const waiting: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const connections = await connectionsWith(waiting);
    const { id } = (await connections.connect(ADDRESS))!;
    const answer = connections.request(id, request());
    await new Promise((resolve) => setTimeout(resolve, 10));
    connections.cancel('bm90LXRoaXMtcmVxdWVzdCE');
    connections.cancel(REQUEST);
    expect(await answer).toEqual({ failed: 'cancelled' });
    // Answered or given up, a request is no longer there to cancel.
    connections.cancel(REQUEST);
  });
});

describe('a login', () => {
  it('has its token kept here: the page gets a marker, and the server gets the token', async () => {
    const { sent, fetcher } = withLogin();
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    expect(await connections.request(id, request())).toMatchObject({ status: 401 });
    expect(sent[0].headers['authorization']).toBeUndefined();

    const answer = await connections.request(id, login());
    expect(said(answer)).toEqual({ token: HELD_LOGIN, account: { name: 'ada', role: 'admin' } });
    expect(JSON.stringify(said(answer))).not.toContain(TOKEN);
    expect(connections.list()[0].loggedIn).toBe(true);

    expect(await connections.request(id, request())).toMatchObject({ status: 200 });
    expect(sent.at(-1)!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('is written down sealed, and is there in the next run', async () => {
    const { sent, fetcher } = withLogin();
    const first = await connectionsWith(fetcher);
    const { id } = (await first.connect(ADDRESS))!;
    await first.request(id, login());
    const written = await kept();
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain('a password');
    expect(JSON.parse(written).connections[0].login).toBe(SEAL.seal(TOKEN));

    const next = await connectionsWith(fetcher);
    expect(next.list()).toEqual([{ id, address: ADDRESS, loggedIn: true }]);
    expect(await next.request(id, request())).toMatchObject({ status: 200 });
    expect(sent.at(-1)!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('asks the system for its seal only when there is a login to seal or to open (#357)', async () => {
    let made = 0;
    const seal = sealWhenNeeded(() => {
      made += 1;
      return SEAL;
    });
    const { fetcher } = withLogin();
    // A start with nothing kept, a server connected to and asked: no login, no seal.
    const first = await connectionsWith(fetcher, { seal });
    const { id } = (await first.connect(ADDRESS))!;
    expect(made).toBe(0);
    // A login is something to seal.
    await first.request(id, login());
    expect(made).toBe(1);
    expect(JSON.parse(await kept()).connections[0].login).toBe(SEAL.seal(TOKEN));

    // The next start has a sealed login to open: its seal is made then, and once.
    let again = 0;
    const next = await connectionsWith(fetcher, {
      seal: sealWhenNeeded(() => {
        again += 1;
        return SEAL;
      }),
    });
    expect(next.list()).toEqual([{ id, address: ADDRESS, loggedIn: true }]);
    expect(await next.request(id, request())).toMatchObject({ status: 200 });
    expect(again).toBe(1);
  });

  it('keeps no login where the system has no seal to give, and asks it once', async () => {
    let made = 0;
    const seal = sealWhenNeeded(() => {
      made += 1;
      return null;
    });
    expect(seal.seal('a login')).toBeNull();
    expect(seal.open('sealed<nigol a>')).toBeNull();
    expect(made).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('is in a file of the user alone', async () => {
    const { fetcher } = withLogin();
    const connections = await connectionsWith(fetcher);
    await connections.request((await connections.connect(ADDRESS))!.id, login());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('is not written down where nothing protects it, and lasts for the run', async () => {
    const { fetcher } = withLogin();
    const first = await connectionsWith(fetcher, { seal: null });
    const { id } = (await first.connect(ADDRESS))!;
    await first.request(id, login());
    expect(first.list()[0].loggedIn).toBe(true);
    expect(await first.request(id, request())).toMatchObject({ status: 200 });
    expect(await kept()).not.toContain('login');
    expect(await kept()).not.toContain(TOKEN);

    expect((await connectionsWith(fetcher, { seal: null })).list()).toEqual([
      { id, address: ADDRESS, loggedIn: false },
    ]);
  });

  it('is no login when what was written cannot be opened here', async () => {
    const { fetcher } = withLogin();
    const first = await connectionsWith(fetcher);
    const { id } = (await first.connect(ADDRESS))!;
    await first.request(id, login());
    const elsewhere: Seal = { seal: () => null, open: () => null };
    const next = await connectionsWith(fetcher, { seal: elsewhere });
    expect(next.list()).toEqual([{ id, address: ADDRESS, loggedIn: false }]);
  });

  it('ends when the page logs out, whatever the server answers', async () => {
    for (const status of [204, 500]) {
      const { sent, fetcher } = serverWith((one) => {
        if (one.method === 'DELETE') return new Response(null, { status });
        return json({ token: TOKEN, account: { name: 'ada', role: 'admin' } });
      });
      const connections = await connectionsWith(fetcher);
      const { id } = (await connections.connect(ADDRESS))!;
      await connections.request(id, login());
      await connections.request(id, request({ method: 'DELETE', path: '/api/v1/session' }));
      // The server was told with the login it is to end.
      expect(sent.at(-1)!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(connections.list()[0].loggedIn).toBe(false);
      expect(await kept()).not.toContain('login');
    }
  });

  it('ends when the server no longer knows it, and not for a refusal of something else', async () => {
    let known = true;
    const { fetcher } = serverWith((sent) => {
      if (sent.method === 'POST') return json({ token: TOKEN, account: { name: 'ada' } });
      if (sent.url.endsWith('/audit')) return json({ error: 'forbidden' }, 403);
      return known ? json({ items: [] }) : json({ error: 'unauthorized' }, 401);
    });
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    await connections.request(id, login());
    expect(await connections.request(id, request({ path: '/api/v1/audit' }))).toMatchObject({
      status: 403,
    });
    expect(connections.list()[0].loggedIn).toBe(true);
    known = false;
    expect(await connections.request(id, request())).toMatchObject({ status: 401 });
    expect(connections.list()[0].loggedIn).toBe(false);
    expect(await kept()).not.toContain('login');
  });

  it('is asked for as nobody, and a wrong password does not end the login there is', async () => {
    let right = true;
    const { sent, fetcher } = serverWith((one) => {
      if (one.method !== 'POST') return json({ items: [] });
      return right
        ? json({ token: TOKEN, account: { name: 'ada' } })
        : json({ error: 'bad-credentials' }, 401);
    });
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    await connections.request(id, login());
    right = false;
    expect(await connections.request(id, login())).toMatchObject({ status: 401 });
    expect(sent.at(-1)!.headers['authorization']).toBeUndefined();
    expect(connections.list()[0].loggedIn).toBe(true);
    await connections.request(id, request());
    expect(sent.at(-1)!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('is not taken from an answer that is no login', async () => {
    for (const answer of [
      () => json({ error: 'unauthorized' }, 401),
      () => json({ token: 7 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      const { fetcher } = serverWith(answer);
      const connections = await connectionsWith(fetcher);
      const { id } = (await connections.connect(ADDRESS))!;
      const given = await connections.request(id, login());
      expect(given).not.toBeNull();
      expect(connections.list()[0].loggedIn).toBe(false);
    }
    // And a token in an answer to something else is the server's business, passed on as it is.
    const { fetcher } = serverWith(() => json({ token: 'of-something-else' }));
    const connections = await connectionsWith(fetcher);
    const { id } = (await connections.connect(ADDRESS))!;
    expect(said(await connections.request(id, request()))).toEqual({ token: 'of-something-else' });
    expect(connections.list()[0].loggedIn).toBe(false);
  });
});
