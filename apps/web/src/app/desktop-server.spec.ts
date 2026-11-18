/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HELD_LOGIN, isGrantId, isServerRequest } from '@open-rt-studio/desktop-bridge';
import { syntheticRtCourse, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';
import { describe, expect, it } from 'vitest';

import { fakeServer } from './data-source/server-testing';
import {
  DesktopFetchError,
  NotConnectedError,
  desktopConnector,
  desktopFetch,
  desktopUnreachable,
} from './desktop-server';
import { fakeDesktopServer } from './desktop-server-testing';

const ADDRESS = 'http://127.0.0.1:4300';
const ADA = { name: 'ada', password: 'correct horse battery staple', role: 'admin' } as const;

/** A server that says back what it was asked. */
const echo: typeof fetch = async (input, init = {}) =>
  new Response(
    JSON.stringify({
      url: String(input),
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body ? new TextDecoder().decode(init.body as Uint8Array) : null,
    }),
    { status: 201, headers: { 'Content-Type': 'application/json', ETag: '"abc"' } },
  );

async function connected(fetcher: typeof fetch = echo) {
  const desktop = fakeDesktopServer(fetcher);
  const connection = (await desktop.connect(ADDRESS))!;
  return { desktop, connection, ask: desktopFetch(desktop, connection) };
}

describe('a request to a server from the desktop application', () => {
  it('goes through the bridge as what it is, and comes back as an answer', async () => {
    const { desktop, ask } = await connected();
    const response = await ask(`${ADDRESS}/api/v1/instances?overwrite=1`, {
      method: 'post',
      headers: { 'Content-Type': 'application/dicom', Authorization: 'Bearer of-the-page' },
      body: new Uint8Array([104, 105]),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('ETag')).toBe('"abc"');
    expect(await response.json()).toEqual({
      url: `${ADDRESS}/api/v1/instances?overwrite=1`,
      method: 'POST',
      // Who is asking is not the page's to say: the main process adds the login it holds.
      headers: { 'content-type': 'application/dicom' },
      body: 'hi',
    });
    const [request] = desktop.requests;
    expect(isServerRequest(request)).toBe(true);
    expect(isGrantId(request.request)).toBe(true);
    expect(request.headers).toEqual({ 'content-type': 'application/dicom' });

    // Text goes as bytes; nothing goes as nothing.
    await ask(`${ADDRESS}/api/v1/session`, { method: 'POST', body: '{"name":"ada"}' });
    expect(new TextDecoder().decode(desktop.requests[1].body!)).toBe('{"name":"ada"}');
    await ask(`${ADDRESS}/api/v1/patients`);
    expect(desktop.requests[2]).toMatchObject({ method: 'GET', body: null, headers: {} });
    // Each request has a name of its own.
    expect(new Set(desktop.requests.map((one) => one.request)).size).toBe(3);
  });

  it('gives an answer that has no body as one', async () => {
    const { ask } = await connected(async () => new Response(null, { status: 204 }));
    const response = await ask(`${ADDRESS}/api/v1/session`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('fails as a fetch does when the server did not answer, with why', async () => {
    const { desktop, connection, ask } = await connected();
    for (const reason of ['unreachable', 'certificate', 'too-large'] as const) {
      desktop.failing = reason;
      const error = await ask(`${ADDRESS}/api/v1/patients`).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ name: 'DesktopFetchError', reason });
    }
    desktop.failing = 'cancelled';
    await expect(ask(`${ADDRESS}/api/v1/patients`)).rejects.toMatchObject({ name: 'AbortError' });
    desktop.failing = null;
    // A connection the main process no longer has.
    await desktop.forget(connection.id);
    await expect(ask(`${ADDRESS}/api/v1/patients`)).rejects.toMatchObject({ reason: 'forgotten' });
    // And it asks only the server it is for.
    const before = desktop.requests.length;
    await expect(ask('http://elsewhere.example/api/v1/patients')).rejects.toBeInstanceOf(
      DesktopFetchError,
    );
    await expect(ask(`${ADDRESS}.elsewhere.example/api/v1/patients`)).rejects.toBeInstanceOf(
      DesktopFetchError,
    );
    expect(desktop.requests.length).toBe(before);
  });

  it('is given up at once when the page gives it up, and the main process is told', async () => {
    let answer: (response: Response) => void = () => undefined;
    const slow: typeof fetch = () => new Promise((resolve) => (answer = resolve));
    const { desktop, ask } = await connected(slow);
    const control = new AbortController();
    const asked = ask(`${ADDRESS}/api/v1/patients`, { signal: control.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    control.abort();
    await expect(asked).rejects.toMatchObject({ name: 'AbortError' });
    expect(desktop.cancelled).toEqual([desktop.requests[0].request]);
    answer(new Response('{}'));

    // One that was given up before it was asked is not asked.
    const before = desktop.requests.length;
    await expect(
      ask(`${ADDRESS}/api/v1/patients`, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(desktop.requests.length).toBe(before);
  });

  it('says why a server was not reached in words for the user', () => {
    const host = '127.0.0.1:4300';
    expect(desktopUnreachable(host, new DesktopFetchError('certificate'))).toBe(
      'The server at 127.0.0.1:4300 was not connected to: this computer does not trust its certificate.',
    );
    expect(desktopUnreachable(host, new DesktopFetchError('unreachable'))).toContain(
      'could not be reached. It may not be running',
    );
    expect(desktopUnreachable(host, new DesktopFetchError('forgotten'))).toContain(
      'no longer one of the saved servers',
    );
    expect(desktopUnreachable(host, new DesktopFetchError('too-large'))).toContain('more than');
    // Nothing of a browser's reasons, which do not apply here.
    expect(desktopUnreachable(host, new TypeError('Failed to fetch'))).not.toContain(
      'allowedOrigins',
    );
  });
});

describe('connecting to a server from the desktop application', () => {
  const files = syntheticRtCourse();
  const connector = desktopConnector;

  it('asks the main process, which asks the user, and reads the server through it', async () => {
    const server = fakeServer(files);
    const desktop = fakeDesktopServer(server.fetch);
    const source = await connector(desktop)('127.0.0.1:4300');
    expect(desktop.asked).toEqual([ADDRESS]);
    expect(source.address).toBe(ADDRESS);
    expect(source.login().kind).toBe('none');
    expect(source.patients().map((patient) => patient.patientId)).toEqual([
      SYNTHETIC_STUDY.patient.id,
    ]);
    // Everything went through the bridge.
    expect(desktop.requests.length).toBe(server.asked.length);
  });

  it('is not connected when the user says no, and does not ask about what is no address', async () => {
    const server = fakeServer(files);
    const desktop = fakeDesktopServer(server.fetch);
    desktop.agrees = false;
    await expect(connector(desktop)(ADDRESS)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(connector(desktop)('ftp://somewhere')).rejects.toThrow(
      'That is not a server address.',
    );
    expect(desktop.asked).toEqual([ADDRESS]);
    expect(server.asked).toEqual([]);
  });

  it('logs in with a token the page never has, and is logged in when it connects again', async () => {
    const server = fakeServer(files, [ADA]);
    const desktop = fakeDesktopServer(server.fetch);
    const source = await connector(desktop)(ADDRESS);
    expect(source.login()).toMatchObject({ kind: 'needed' });

    await source.logIn(ADA.name, ADA.password);
    expect(source.login()).toMatchObject({ kind: 'in', name: 'ada' });
    expect(source.patients()).toHaveLength(1);
    // The token is the main process's; what the page was given is a marker.
    const [token] = server.tokens();
    expect(token).not.toBe(HELD_LOGIN);
    expect([...desktop.tokens.values()]).toEqual([token]);
    expect(desktop.requests.every((request) => !('authorization' in request.headers))).toBe(true);

    // Later, in another run: the main process still holds the login.
    const again = await connector(desktop)(ADDRESS);
    expect(again.login()).toMatchObject({ kind: 'in', name: 'ada' });
    expect(again.patients()).toHaveLength(1);
    expect(desktop.asked).toHaveLength(1);

    // Logging out ends it at the server and in the main process.
    await again.logOut();
    expect(server.tokens()).toEqual([]);
    expect(desktop.tokens.size).toBe(0);
  });

  it('says that a login has ended when the one that was held no longer holds', async () => {
    const server = fakeServer(files, [ADA]);
    const desktop = fakeDesktopServer(server.fetch);
    await (await connector(desktop)(ADDRESS)).logIn(ADA.name, ADA.password);
    server.endSessions();
    const again = await connector(desktop)(ADDRESS);
    expect(again.login()).toEqual({ kind: 'needed', ended: true });
    expect(desktop.tokens.size).toBe(0);
  });

  it('says what the main process found when the server is not reached', async () => {
    const desktop = fakeDesktopServer(fakeServer(files).fetch);
    desktop.failing = 'certificate';
    await expect(connector(desktop)('https://pacs.example.org')).rejects.toThrow(
      'The server at pacs.example.org was not connected to: this computer does not trust its certificate.',
    );
  });
});
