/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteAccountStore } from './accounts/account-store.js';
import { createAccounts } from './accounts/accounts.js';
import { API_PREFIX } from './api/api-routes.js';
import { ConfigError, DEFAULT_CONFIG, resolveConfig, type ServerConfig } from './config.js';
import { dicomEcho } from './dimse/echo.js';
import { createLogger, SILENT_LOGGER } from './logger.js';
import {
  CERTIFICATE_WARNING_DAYS,
  openDicomTls,
  openTls,
  startServer,
  startWarnings,
  type RunningServer,
} from './server.js';
import { testCertificate, type TestCertificate } from './tls-testing.js';

// HTTPS for the API (#57): the certificate is checked when the server
// starts, so that what is wrong with it is said there and not met by a
// client as a connection that fails without a reason.

const DAY = 86_400_000;
const ADA = { name: 'ada', password: 'correct horse battery staple' };

let directory: string;
let server: RunningServer | null = null;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-tls-'));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

/** Write a certificate and a key to files, and give the configuration that names them. */
async function configured(
  cert: string,
  key: string,
  more: Partial<ServerConfig> = {},
): Promise<ServerConfig> {
  const tlsCert = join(directory, 'cert.pem');
  const tlsKey = join(directory, 'key.pem');
  await writeFile(tlsCert, cert);
  await writeFile(tlsKey, key);
  return { ...DEFAULT_CONFIG, port: 0, shutdownTimeoutMs: 2_000, tlsCert, tlsKey, ...more };
}

describe('the certificate, when the server starts', () => {
  it('is read with its key, and both are given as they are', async () => {
    const made = testCertificate();
    const config = await configured(made.cert, made.key);
    expect(openTls(config, SILENT_LOGGER)).toEqual({ cert: made.cert, key: made.key });
  });

  it('is not asked for by a server that speaks HTTP', () => {
    expect(openTls(DEFAULT_CONFIG, SILENT_LOGGER)).toBeNull();
  });

  it('says which file could not be read, by the setting that names it', async () => {
    const made = testCertificate();
    const config = await configured(made.cert, made.key);
    expect(() =>
      openTls({ ...config, tlsCert: join(directory, 'absent.pem') }, SILENT_LOGGER),
    ).toThrow(new ConfigError('The file OPEN_RT_STUDIO_TLS_CERT names could not be read.'));
    expect(() =>
      openTls({ ...config, tlsKey: join(directory, 'absent.pem') }, SILENT_LOGGER),
    ).toThrow(new ConfigError('The file OPEN_RT_STUDIO_TLS_KEY names could not be read.'));
  });

  it('says when a file is not what it should be, and repeats nothing of it', async () => {
    const made = testCertificate();
    const notCert = await configured('this is a secret, and no certificate', made.key);
    expect(() => openTls(notCert, SILENT_LOGGER)).toThrow(
      new ConfigError('The file OPEN_RT_STUDIO_TLS_CERT names is not a certificate in PEM.'),
    );
    // The two the wrong way round is the mistake that is made.
    const swapped = await configured(made.key, made.cert);
    expect(() => openTls(swapped, SILENT_LOGGER)).toThrow(/is not a certificate in PEM/);
    const notKey = await configured(made.cert, 'this is a secret, and no key');
    expect(() => openTls(notKey, SILENT_LOGGER)).toThrow(
      new ConfigError(
        'The file OPEN_RT_STUDIO_TLS_KEY names is not a private key in PEM, or is protected by a passphrase, which the server does not take.',
      ),
    );
  });

  it('says when the key is protected by a passphrase', async () => {
    const made = testCertificate();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const locked = privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'a passphrase' })
      .toString();
    const config = await configured(made.cert, locked);
    expect(() => openTls(config, SILENT_LOGGER)).toThrow(/protected by a passphrase/);
  });

  it('says when the key is not the certificate’s', async () => {
    const config = await configured(testCertificate().cert, testCertificate().key);
    expect(() => openTls(config, SILENT_LOGGER)).toThrow(
      new ConfigError('The certificate and the key do not belong together.'),
    );
  });

  it('says when the certificate has expired, or is not valid yet, and on which day', async () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const past = testCertificate({
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2026-06-01T00:00:00Z'),
    });
    expect(() => openTls({ ...DEFAULT_CONFIG }, SILENT_LOGGER, () => now)).not.toThrow();
    const expired = await configured(past.cert, past.key);
    expect(() => openTls(expired, SILENT_LOGGER, () => now)).toThrow(
      new ConfigError('The certificate expired on 2026-06-01.'),
    );
    const future = testCertificate({
      notBefore: new Date('2026-07-01T00:00:00Z'),
      notAfter: new Date('2026-12-01T00:00:00Z'),
    });
    const early = await configured(future.cert, future.key);
    expect(() => openTls(early, SILENT_LOGGER, () => now)).toThrow(
      new ConfigError('The certificate is not valid until 2026-07-01.'),
    );
  });

  it('warns when the certificate ends soon, with the days left and nothing else', async () => {
    const start = Date.parse('2026-06-01T00:00:00Z');
    const made = testCertificate({
      notBefore: new Date(start),
      notAfter: new Date(start + 90 * DAY),
    });
    const config = await configured(made.cert, made.key);
    const warnedAt = (days: number): Record<string, unknown>[] => {
      const lines: string[] = [];
      const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
      openTls(config, logger, () => start + days * DAY + 1000);
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    expect(warnedAt(1)).toEqual([]);
    expect(warnedAt(90 - CERTIFICATE_WARNING_DAYS - 1)).toEqual([]);
    const soon = warnedAt(90 - 10);
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({ level: 'warn', event: 'certificate-expires-soon', days: 9 });
    expect(Object.keys(soon[0]).sort()).toEqual(['days', 'event', 'level', 'time']);
  });

  it('keeps a server with a wrong certificate from starting, and opens nothing for it', async () => {
    const config = await configured(testCertificate().cert, testCertificate().key);
    await expect(startServer({ ...config, auth: 'none' }, SILENT_LOGGER)).rejects.toThrow(
      'The certificate and the key do not belong together.',
    );
  });
});

interface Answer {
  readonly status: number;
  readonly text: string;
  /** The version of TLS the connection settled on. */
  readonly protocol: string | null;
}

/** Ask over HTTPS, trusting `authority` and nothing else. */
function ask(
  port: number,
  path: string,
  authority: string,
  options: RequestOptions & { readonly body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const { body, ...rest } = options;
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, ca: authority, agent: false, ...rest },
      (response) => {
        const protocol = (response.socket as { getProtocol?: () => string | null }).getProtocol?.();
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, text, protocol: protocol ?? null }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

describe('a server with a certificate', () => {
  async function started(more: Partial<ServerConfig> = {}) {
    const made: TestCertificate = testCertificate();
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    const accounts = createAccounts({
      store: openSqliteAccountStore(':memory:'),
      cost: { logN: 4, r: 8, p: 1 },
      logger,
    });
    await accounts.add(ADA.name, ADA.password, 'admin');
    server = await startServer(await configured(made.cert, made.key, more), logger, { accounts });
    return {
      made,
      port: server.address.port,
      log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  }

  it('answers over HTTPS, to a client that trusts the certificate', async () => {
    const { made, port, log } = await started();
    expect(server!.tls).toBe(true);
    const health = await ask(port, '/health', made.cert);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ status: 'ok' });
    expect(health.protocol).toBe('TLSv1.3');
    expect(log()).toContainEqual(
      expect.objectContaining({ event: 'listening', host: '127.0.0.1', port, tls: true }),
    );
    // By the name the certificate is for, too.
    const byName = await ask(port, '/health', made.cert, { host: 'localhost' });
    expect(byName.status).toBe(200);
  });

  it('is the same server over it: a login, and what the login may see', async () => {
    const { made, port } = await started();
    expect((await ask(port, `${API_PREFIX}/studies`, made.cert)).status).toBe(401);
    const login = await ask(port, `${API_PREFIX}/session`, made.cert, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADA),
    });
    expect(login.status).toBe(200);
    const { token } = JSON.parse(login.text) as { token: string };
    const studies = await ask(port, `${API_PREFIX}/studies`, made.cert, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(studies.status).toBe(200);
    expect(JSON.parse(studies.text)).toMatchObject({ items: [], more: false });
  });

  it('is not trusted by a client that was not given the certificate', async () => {
    const { port } = await started();
    await expect(ask(port, '/health', testCertificate().cert)).rejects.toMatchObject({
      code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/) as unknown,
    });
  });

  it('speaks TLS 1.2 and later, and no earlier', async () => {
    const { made, port } = await started();
    const twelve = await ask(port, '/health', made.cert, {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    });
    expect([twelve.status, twelve.protocol]).toEqual([200, 'TLSv1.2']);
    await expect(
      ask(port, '/health', made.cert, { minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1' }),
    ).rejects.toThrow();
  });

  it('does not answer plain HTTP on its port', async () => {
    const { port, log } = await started();
    const plain = new Promise<string>((resolve) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/health', agent: false });
      request.on('response', (response) => resolve(`answered ${response.statusCode}`));
      request.on('error', () => resolve('refused'));
      request.end();
    });
    expect(await plain).toBe('refused');
    // Not a request, and not logged as one.
    expect(log().filter((line) => line['event'] === 'request')).toEqual([]);
  });

  it('stops cleanly', async () => {
    const { made, port } = await started();
    await ask(port, '/health', made.cert);
    expect(await server!.stop()).toBe(true);
    await expect(ask(port, '/health', made.cert)).rejects.toThrow();
  });
});

describe('what a server warns of as it starts', () => {
  const events = (config: Partial<ServerConfig>, accounts: number | null, tls: boolean) =>
    startWarnings({ ...DEFAULT_CONFIG, ...config }, { accounts, tls }).map((one) => one.event);

  it('says nothing of a server on this machine with accounts', () => {
    expect(events({}, 1, false)).toEqual([]);
    expect(events({}, 1, true)).toEqual([]);
  });

  it('warns when others can reach it and it does not encrypt', () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10', 'pacs.example.org']) {
      expect(events({ host }, 2, false), host).toEqual(['no-tls']);
      expect(events({ host }, 2, true), host).toEqual([]);
    }
  });

  it('warns of no login, of the pages that are let in then, and of no account to log in with', () => {
    expect(events({ auth: 'none' }, null, false)).toEqual(['no-login']);
    expect(
      startWarnings(
        { ...DEFAULT_CONFIG, auth: 'none', allowedOrigins: ['http://localhost:4200'] },
        { accounts: null, tls: false },
      ),
    ).toEqual([{ event: 'no-login' }, { event: 'origins-allowed', fields: { count: 1 } }]);
    expect(events({}, 0, false)).toEqual(['no-accounts']);
    expect(events({ host: '0.0.0.0' }, 0, false)).toEqual(['no-accounts', 'no-tls']);
  });
});

// The same checks for the certificate the server shows over DICOM, and the
// authorities it trusts other systems by.
describe('the certificate for DICOM, when the server starts', () => {
  async function forDicom(
    cert: string,
    key: string,
    ca: string | null = null,
    more: Partial<ServerConfig> = {},
  ): Promise<ServerConfig> {
    const dicomTlsCert = join(directory, 'dicom-cert.pem');
    const dicomTlsKey = join(directory, 'dicom-key.pem');
    const dicomTlsCa = ca === null ? null : join(directory, 'dicom-ca.pem');
    await writeFile(dicomTlsCert, cert);
    await writeFile(dicomTlsKey, key);
    if (dicomTlsCa !== null) await writeFile(dicomTlsCa, ca!);
    return {
      ...DEFAULT_CONFIG,
      port: 0,
      shutdownTimeoutMs: 2_000,
      dicomTlsCert,
      dicomTlsKey,
      dicomTlsCa,
      ...more,
    };
  }

  it('is not asked for: a server without one calls with TLS and cannot listen with it', () => {
    expect(openDicomTls(DEFAULT_CONFIG, SILENT_LOGGER)).toBeNull();
  });

  it('is read with its key, and with the authorities when some are named', async () => {
    const authority = testCertificate({ authority: true });
    const made = testCertificate({ signedBy: authority });
    expect(openDicomTls(await forDicom(made.cert, made.key), SILENT_LOGGER)).toEqual({
      cert: made.cert,
      key: made.key,
      ca: null,
    });
    // More than one authority in a file.
    const two = authority.cert + testCertificate({ authority: true }).cert;
    expect(openDicomTls(await forDicom(made.cert, made.key, two), SILENT_LOGGER)).toEqual({
      cert: made.cert,
      key: made.key,
      ca: two,
    });
  });

  it('says what is wrong by the setting that names the file, and repeats nothing of it', async () => {
    const made = testCertificate();
    const config = await forDicom(made.cert, made.key);
    expect(() =>
      openDicomTls({ ...config, dicomTlsCert: join(directory, 'absent.pem') }, SILENT_LOGGER),
    ).toThrow(new ConfigError('The file OPEN_RT_STUDIO_DICOM_TLS_CERT names could not be read.'));
    expect(() =>
      openDicomTls({ ...config, dicomTlsCa: join(directory, 'absent.pem') }, SILENT_LOGGER),
    ).toThrow(new ConfigError('The file OPEN_RT_STUDIO_DICOM_TLS_CA names could not be read.'));
    const swapped = await forDicom(made.key, made.cert);
    expect(() => openDicomTls(swapped, SILENT_LOGGER)).toThrow(
      new ConfigError('The file OPEN_RT_STUDIO_DICOM_TLS_CERT names is not a certificate in PEM.'),
    );
    const mismatched = await forDicom(made.cert, testCertificate().key);
    expect(() => openDicomTls(mismatched, SILENT_LOGGER)).toThrow(
      new ConfigError('The certificate and the key for DICOM do not belong together.'),
    );
    // Authorities that are none would trust no one: said, with nothing of the file.
    for (const wrong of ['this is a secret, and no certificate', made.key]) {
      const notCa = await forDicom(made.cert, made.key, wrong);
      const thrown = (() => {
        try {
          openDicomTls(notCa, SILENT_LOGGER);
          return null;
        } catch (error) {
          return error as Error;
        }
      })();
      expect(thrown).toEqual(
        new ConfigError('The file OPEN_RT_STUDIO_DICOM_TLS_CA names is not certificates in PEM.'),
      );
      expect(thrown!.message).not.toContain('secret');
    }
  });

  it('says when the certificate has expired, and on which day', async () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const past = testCertificate({
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2026-06-01T00:00:00Z'),
    });
    expect(() => openDicomTls(DEFAULT_CONFIG, SILENT_LOGGER, () => now)).not.toThrow();
    const expired = await forDicom(past.cert, past.key);
    expect(() => openDicomTls(expired, SILENT_LOGGER, () => now)).toThrow(
      new ConfigError('The certificate for DICOM expired on 2026-06-01.'),
    );
  });

  it('warns when it ends soon, and says which certificate', async () => {
    const start = Date.parse('2026-06-01T00:00:00Z');
    const made = testCertificate({
      notBefore: new Date(start),
      notAfter: new Date(start + 30 * DAY),
    });
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    openDicomTls(await forDicom(made.cert, made.key), logger, () => start + 20 * DAY + 1);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { event: 'certificate-expires-soon', days: 9, use: 'dicom' },
    ]);
  });

  it('wants a certificate with the authorities, and a key with the certificate', () => {
    expect(() =>
      openDicomTls({ ...DEFAULT_CONFIG, dicomTlsCa: '/etc/ca.pem' }, SILENT_LOGGER),
    ).toThrow(
      new ConfigError(
        'OPEN_RT_STUDIO_DICOM_TLS_CA names authorities for TLS over DICOM, and the server has no certificate of its own for it: set OPEN_RT_STUDIO_DICOM_TLS_CERT and OPEN_RT_STUDIO_DICOM_TLS_KEY too.',
      ),
    );
    expect(() => resolveConfig({ dicomTlsCert: '/etc/cert.pem' })).toThrow(
      new ConfigError(
        'TLS for DICOM takes a certificate and its key: set both OPEN_RT_STUDIO_DICOM_TLS_CERT and OPEN_RT_STUDIO_DICOM_TLS_KEY, or neither.',
      ),
    );
  });

  it('has a server that listens for DICOM listen with TLS, with no more said', async () => {
    const made = testCertificate();
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    server = await startServer(
      await forDicom(made.cert, made.key, null, {
        auth: 'none',
        dicomPort: 0,
        dicomCallers: ['PEER'],
      }),
      logger,
    );
    expect(server.dicom).toMatchObject({ host: '127.0.0.1', tls: true });
    const target = {
      host: '127.0.0.1',
      port: server.dicom!.port,
      callingAeTitle: 'PEER',
      calledAeTitle: DEFAULT_CONFIG.dicomAeTitle,
      timeoutMs: 2_000,
    };
    expect(await dicomEcho({ ...target, tls: { ca: made.cert } })).toEqual({ outcome: 'ok' });
    expect(await dicomEcho(target)).toEqual({ outcome: 'broken' });
    // The API is another matter: it has no certificate here, and speaks HTTP.
    expect(server.tls).toBe(false);
    const said = lines.join('\n');
    expect(said).toContain('"dicom-listening"');
    expect(said).not.toContain('BEGIN');
  });

  it('does not start a server whose kept settings say TLS once it has no certificate', async () => {
    const made = testCertificate();
    const dataDir = join(directory, 'data');
    const config = await forDicom(made.cert, made.key, null, {
      auth: 'none',
      dataDir,
      dicomPort: 0,
    });
    server = await startServer(config, SILENT_LOGGER);
    // Kept as it is, by a change that changes nothing else.
    const local = await fetch(`http://127.0.0.1:${server.address.port}${API_PREFIX}/dicom/local`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, port: 0, aeTitle: 'ORS', tls: true }),
    });
    expect(local.status).toBe(200);
    await server.stop();
    server = null;
    await expect(
      startServer({ ...config, dicomTlsCert: null, dicomTlsKey: null }, SILENT_LOGGER),
    ).rejects.toThrow(
      new ConfigError(
        'The DICOM settings that were kept say to listen with TLS, and the server has no certificate for DICOM. Set OPEN_RT_STUDIO_DICOM_TLS_CERT and OPEN_RT_STUDIO_DICOM_TLS_KEY, or take "tls" out of the local settings in dicom.json in the data directory.',
      ),
    );
    // With the certificate again, it is as it was left.
    server = await startServer(config, SILENT_LOGGER);
    expect(server.dicom).toMatchObject({ tls: true });
  });
});
