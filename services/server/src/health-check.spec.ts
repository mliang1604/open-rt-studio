/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG } from './config.js';
import { askHealth, healthAddress } from './health-check.js';
import { SILENT_LOGGER } from './logger.js';
import { startServer, type RunningServer } from './server.js';
import { testCertificate } from './tls-testing.js';

// The `health` command: what a container runtime asks to know that the
// server is up (#59).

describe('where the server is asked', () => {
  const at = (host: string, tlsCert: string | null = null): string =>
    healthAddress({ host, port: 4300, tlsCert }).href;

  it('is the address it listens on', () => {
    expect(at('127.0.0.1')).toBe('http://127.0.0.1:4300/health');
    expect(at('192.0.2.7')).toBe('http://192.0.2.7:4300/health');
    expect(at('::1')).toBe('http://[::1]:4300/health');
  });

  it('is this machine itself when it listens on every address', () => {
    expect(at('0.0.0.0')).toBe('http://127.0.0.1:4300/health');
    expect(at('::')).toBe('http://[::1]:4300/health');
  });

  it('is over HTTPS when the server has a certificate', () => {
    expect(at('0.0.0.0', '/etc/cert.pem')).toBe('https://127.0.0.1:4300/health');
  });
});

describe('asking the server', () => {
  let directory: string;
  let server: RunningServer | null = null;
  let other: Server | null = null;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-health-'));
  });
  afterEach(async () => {
    await server?.stop();
    server = null;
    await new Promise((done) => (other ? other.close(done) : done(null)));
    other = null;
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  const OPEN = { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 2_000 } as const;

  /** Something that is not the server, answering as told. */
  async function answering(status: number, body: string, afterMs = 0): Promise<number> {
    other = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
      }, afterMs);
    });
    await new Promise<void>((done) => other!.listen(0, '127.0.0.1', done));
    return (other.address() as AddressInfo).port;
  }

  it('is true of a server that runs, and false once it has stopped', async () => {
    server = await startServer(OPEN, SILENT_LOGGER);
    const config = { host: '127.0.0.1', port: server.address.port, tlsCert: null };
    expect(await askHealth(config)).toBe(true);
    await server.stop();
    server = null;
    expect(await askHealth(config)).toBe(false);
  });

  it('is true of a server that asks for a login: its health is for anyone to ask', async () => {
    server = await startServer(
      { ...DEFAULT_CONFIG, port: 0, shutdownTimeoutMs: 2_000, dataDir: directory },
      SILENT_LOGGER,
    );
    expect(await askHealth({ host: '127.0.0.1', port: server.address.port, tlsCert: null })).toBe(
      true,
    );
  });

  it('asks over HTTPS a server that has a certificate, whatever name it is made out to', async () => {
    const made = testCertificate();
    const tlsCert = join(directory, 'cert.pem');
    const tlsKey = join(directory, 'key.pem');
    await writeFile(tlsCert, made.cert);
    await writeFile(tlsKey, made.key);
    server = await startServer({ ...OPEN, tlsCert, tlsKey }, SILENT_LOGGER);
    const { port } = server.address;
    expect(await askHealth({ host: '127.0.0.1', port, tlsCert })).toBe(true);
    // Asked without TLS, a server that speaks it gives no health answer.
    expect(await askHealth({ host: '127.0.0.1', port, tlsCert: null })).toBe(false);
  });

  it('is false of an answer that is not the server being well', async () => {
    const config = async (status: number, body: string) => ({
      host: '127.0.0.1',
      port: await answering(status, body),
      tlsCert: null,
    });
    expect(await askHealth(await config(200, '{"status":"ok"}'))).toBe(true);
    await new Promise((done) => other!.close(done));
    expect(await askHealth(await config(503, '{"status":"ok"}'))).toBe(false);
    await new Promise((done) => other!.close(done));
    expect(await askHealth(await config(200, '{"status":"stopping"}'))).toBe(false);
    await new Promise((done) => other!.close(done));
    expect(await askHealth(await config(200, 'not JSON'))).toBe(false);
  });

  it('does not wait for an answer that does not come', async () => {
    const port = await answering(200, '{"status":"ok"}', 2_000);
    const began = Date.now();
    expect(await askHealth({ host: '127.0.0.1', port, tlsCert: null }, 100)).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_500);
    other!.closeAllConnections();
  });
});
