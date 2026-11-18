/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TLS for DICOM associations (#57): the server's listener with a
// certificate, and its own calls to it. The certificates are made on the
// spot. DCMTK's tools are the other side in dcmtk.spec.ts.

import { connect } from 'node:tls';

import {
  SYNTHETIC_RT_COURSE,
  syntheticCtSeries,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import type { Pacs } from '../core/core.js';
import { createLogger } from '../logger.js';
import { testCertificate, type TestCertificate } from '../tls-testing.js';
import { findAt, moveFrom } from './ask.js';
import { dicomEcho } from './echo.js';
import { dataSetOf } from './part10.js';
import { outgoingFrom, sendObjects, type SendTarget } from './send.js';
import {
  freePort,
  LISTENER_AE,
  PEER_AE,
  startTestListener,
  type TestListener,
} from './testing/peer.js';
import {
  clientTls,
  securityOptions,
  TLS_FAILURES,
  tlsFailureOf,
  tlsProblem,
  type ClientTls,
} from './tls.js';

const DAY = 86_400_000;

const open: TestListener[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

type Options = Parameters<typeof startTestListener>[0];

async function listening(options: Options = {}): Promise<TestListener> {
  const started = await startTestListener(options);
  open.push(started);
  return started;
}

/** A listener with TLS, and what it wrote to its log. */
async function secure(
  own: TestCertificate,
  ca: string | null = null,
  options: Options = {},
): Promise<TestListener & { readonly log: () => string }> {
  const lines: string[] = [];
  const started = await listening({
    tls: { cert: own.cert, key: own.key, ca },
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    ...options,
  });
  return { ...started, log: () => lines.join('\n') };
}

const to = (port: number, tls?: ClientTls, more: Partial<SendTarget> = {}): SendTarget => ({
  host: '127.0.0.1',
  port,
  calledAeTitle: LISTENER_AE,
  callingAeTitle: PEER_AE,
  timeoutMs: 3_000,
  ...(tls ? { tls } : {}),
  ...more,
});

async function kept(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

describe('what an error of a TLS connection says went wrong', () => {
  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls-untrusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls-untrusted'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls-untrusted'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls-untrusted'],
    ['CERT_HAS_EXPIRED', 'tls-expired'],
    ['CERT_NOT_YET_VALID', 'tls-expired'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls-name'],
    ['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'tls-refused'],
    ['ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'tls-refused'],
    ['ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'tls-refused'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls-failed'],
    ['ECONNRESET', 'tls-failed'],
    ['EPROTO', 'tls-failed'],
  ])('%s is %s', (code, failure) => {
    expect(tlsFailureOf({ code }, false)).toBe(failure);
    expect(TLS_FAILURES).toContain(failure);
  });

  it.each(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'])(
    '%s is not a matter of TLS',
    (code) => {
      expect(tlsFailureOf({ code }, false)).toBeNull();
    },
  );

  it('takes a connection cut once the handshake was made as a refusal, and no other error', () => {
    expect(tlsFailureOf({ code: 'ECONNRESET' }, true)).toBe('tls-refused');
    expect(tlsFailureOf({ code: 'ETIMEDOUT' }, true)).toBeNull();
    expect(tlsFailureOf(new Error('anything'), true)).toBeNull();
    expect(tlsFailureOf(null, false)).toBe('tls-failed');
  });
});

describe('what the server brings to a call over TLS', () => {
  it('is nothing when it was given no certificate: the machine’s authorities are trusted', () => {
    expect(clientTls(null)).toEqual({});
  });

  it('is its certificate, and its authorities when it was given some', () => {
    expect(clientTls({ cert: 'C', key: 'K', ca: null })).toEqual({ cert: 'C', key: 'K' });
    expect(clientTls({ cert: 'C', key: 'K', ca: 'A' })).toEqual({ cert: 'C', key: 'K', ca: 'A' });
  });

  it('always checks the other system’s certificate, and speaks TLS 1.2 or later', () => {
    expect(securityOptions({ ca: 'A' })).toEqual({
      ca: 'A',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
  });
});

describe('a listener with a certificate', () => {
  // The issue's second "done when", with a peer of our own; DCMTK is the peer in CI.
  it('answers an echo over TLS from a caller that trusts its certificate', async () => {
    const own = testCertificate();
    const there = await secure(own);
    expect(there.listener.tls).toBe(true);
    expect(await dicomEcho(to(there.port, { ca: own.cert }))).toEqual({ outcome: 'ok' });
    expect(there.log()).toContain('"tls":true');
  });

  it('is not trusted by a caller that was not given its certificate', async () => {
    const there = await secure(testCertificate());
    // Trusted by the authorities the machine knows, of which it has none.
    expect(await dicomEcho(to(there.port, {}))).toEqual({ outcome: 'tls-untrusted' });
    // By another certificate than its own.
    expect(await dicomEcho(to(there.port, { ca: testCertificate().cert }))).toEqual({
      outcome: 'tls-untrusted',
    });
  });

  it('is told apart from one whose certificate has expired', async () => {
    const own = testCertificate({
      notBefore: new Date(Date.now() - 60 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    const there = await secure(own);
    expect(await dicomEcho(to(there.port, { ca: own.cert }))).toEqual({ outcome: 'tls-expired' });
  });

  it('is told apart from one whose certificate is not valid yet', async () => {
    const own = testCertificate({
      notBefore: new Date(Date.now() + DAY),
      notAfter: new Date(Date.now() + 30 * DAY),
    });
    const there = await secure(own);
    expect(await dicomEcho(to(there.port, { ca: own.cert }))).toEqual({ outcome: 'tls-expired' });
  });

  it('is told apart from one whose certificate is for another name', async () => {
    const own = testCertificate({ names: ['pacs.example.org'] });
    const there = await secure(own);
    expect(await dicomEcho(to(there.port, { ca: own.cert }))).toEqual({ outcome: 'tls-name' });
    // By the name the certificate is for, `localhost`, as by the address.
    const named = testCertificate();
    const other = await secure(named);
    expect(await dicomEcho(to(other.port, { ca: named.cert }, { host: 'localhost' }))).toEqual({
      outcome: 'ok',
    });
  });

  it('does not answer a caller that does not use TLS, and says so in its log', async () => {
    const there = await secure(testCertificate());
    // The connection is made and ended: something is there, and it gave no answer.
    expect(await dicomEcho(to(there.port))).toEqual({ outcome: 'broken' });
    await vi.waitFor(() => expect(there.log()).toContain('tls-handshake-failed'));
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('speaks TLS 1.2 and later, and no earlier', async () => {
    const own = testCertificate();
    const there = await secure(own);
    const spoken = (version: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'): Promise<string> =>
      new Promise((resolve) => {
        const socket = connect({
          host: '127.0.0.1',
          port: there.port,
          ca: own.cert,
          minVersion: version,
          maxVersion: version,
        });
        socket.once('secureConnect', () => {
          resolve(socket.getProtocol() ?? 'none');
          socket.destroy();
        });
        socket.once('error', () => resolve('refused'));
      });
    expect(await spoken('TLSv1.3')).toBe('TLSv1.3');
    expect(await spoken('TLSv1.2')).toBe('TLSv1.2');
    expect(await spoken('TLSv1.1')).toBe('refused');
  });

  it('takes objects over TLS as the bytes they were sent in', async () => {
    const own = testCertificate();
    const there = await secure(own);
    const files = syntheticCtSeries(3, 8);
    const objects = files.map((file) => outgoingFrom(file.bytes)!);
    const outcomes = await sendObjects(to(there.port, { ca: own.cert }), objects);
    expect(outcomes).toEqual(
      objects.map(() => ({ outcome: 'stored', status: 0, rewritten: false })),
    );
    for (const object of objects) {
      const arrived = await kept(there.core.pacs!, object.sopInstanceUid);
      expect(Buffer.from(dataSetOf(arrived)!).equals(Buffer.from(object.dataSet))).toBe(true);
    }
  });

  it('says of each object why none was sent, when its certificate is not trusted', async () => {
    const there = await secure(testCertificate());
    const objects = syntheticCtSeries(2, 8).map((file) => outgoingFrom(file.bytes)!);
    expect(await sendObjects(to(there.port, {}), objects)).toEqual([
      { outcome: 'tls-untrusted' },
      { outcome: 'tls-untrusted' },
    ]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('is asked what it holds over TLS, and sends it over TLS to where it is told', async () => {
    const [ownHere, ownThere] = [testCertificate(), testCertificate()];
    // This server: it takes what the other system sends it, over TLS.
    const here = await secure(ownHere, null, { aeTitle: 'OURS', callers: [LISTENER_AE] });
    const there = await secure(ownThere, null, {
      callers: [],
      retrievers: ['OURS'],
      destinationOf: (aeTitle) =>
        aeTitle === 'OURS'
          ? { host: '127.0.0.1', port: here.port, tls: { ca: ownHere.cert } }
          : null,
      moveTimeoutMs: 3_000,
    });
    for (const file of syntheticRtCourse()) {
      expect((await there.core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
    }
    const target = to(there.port, { ca: ownThere.cert }, { callingAeTitle: 'OURS' });
    const found = await findAt(target, 'study', { patientId: 'SYN-0001' });
    expect(found.outcome === 'answered' && found.matches.length).toBe(2);

    const moved = await moveFrom(target, 'OURS', {
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    expect(moved).toMatchObject({ outcome: 'answered', status: 0 });
    expect(await here.core.pacs!.index.counts()).toMatchObject({ instances: 8 });

    // Asked without trusting it: why not, and no answer.
    expect(await findAt(to(there.port, {}), 'study', {})).toEqual({ outcome: 'tls-untrusted' });
    expect(
      await moveFrom(to(there.port, {}), 'OURS', {
        studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
      }),
    ).toEqual({ outcome: 'tls-untrusted' });
  });
});

describe('a listener that asks who calls', () => {
  const authority = testCertificate({ authority: true });
  const own = testCertificate({ signedBy: authority });
  const caller = testCertificate({ signedBy: authority, names: ['caller.example.org'] });

  it('answers a caller that shows a certificate of its authority', async () => {
    const there = await secure(own, authority.cert);
    expect(
      await dicomEcho(to(there.port, { ca: authority.cert, cert: caller.cert, key: caller.key })),
    ).toEqual({ outcome: 'ok' });
    expect(there.log()).toContain('"callersShowCertificates":true');
  });

  it('does not hear a caller that shows none, which is told it was refused', async () => {
    const there = await secure(own, authority.cert);
    expect(await dicomEcho(to(there.port, { ca: authority.cert }))).toEqual({
      outcome: 'tls-refused',
    });
    expect(there.log()).toContain('tls-caller-not-trusted');
    expect(there.log()).not.toContain('association-accepted');
  });

  it('does not hear a caller whose certificate is of another authority, or of none', async () => {
    const there = await secure(own, authority.cert);
    const others = testCertificate({ signedBy: testCertificate({ authority: true }) });
    const self = testCertificate();
    for (const shown of [others, self]) {
      expect(
        await dicomEcho(to(there.port, { ca: authority.cert, cert: shown.cert, key: shown.key })),
      ).toEqual({ outcome: 'tls-refused' });
    }
    // Why, by the check's own word, and nothing of the certificate.
    expect(there.log()).toMatch(/"tls-caller-not-trusted".*"reason":"[A-Z_]+"/);
    expect(there.log()).not.toContain('caller.example.org');
    expect(there.log()).not.toContain('association-accepted');
  });

  it('stores nothing from a caller it does not hear', async () => {
    const there = await secure(own, authority.cert);
    const objects = syntheticCtSeries(1, 8).map((file) => outgoingFrom(file.bytes)!);
    expect(await sendObjects(to(there.port, { ca: authority.cert }), objects)).toEqual([
      { outcome: 'tls-refused' },
    ]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });
});

describe('a call over TLS to what does not speak it', () => {
  it('says so of a listener without TLS', async () => {
    const there = await listening();
    // It takes what it is sent for the start of an association, and waits for the rest.
    expect(await dicomEcho(to(there.port, {}, { timeoutMs: 1_000 }))).toEqual({
      outcome: 'tls-failed',
    });
    expect(await tlsProblem({ host: '127.0.0.1', port: there.port, tls: {} }, 1_000)).toBe(
      'tls-failed',
    );
  });

  it('says nothing answered where nothing listens: that is not a matter of TLS', async () => {
    const port = await freePort();
    expect(await dicomEcho(to(port, {}))).toEqual({ outcome: 'unreachable' });
    expect(await tlsProblem({ host: '127.0.0.1', port, tls: {} }, 2_000)).toBeNull();
  });

  it('finds nothing wrong with a listener it trusts', async () => {
    const own = testCertificate();
    const there = await secure(own);
    expect(
      await tlsProblem({ host: '127.0.0.1', port: there.port, tls: { ca: own.cert } }, 2_000),
    ).toBeNull();
  });
});
