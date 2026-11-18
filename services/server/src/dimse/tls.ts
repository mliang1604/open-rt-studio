/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TLS for DICOM associations (#57): what the server shows of itself, whom it
// trusts, and what went wrong when a secure connection could not be made.
//
// A certificate problem reaches the library as a connection that failed,
// with the reason only in a sentence of OpenSSL's. So when a call over TLS
// came to nothing, the address is asked once more by a connection of our
// own that does the handshake and no more, and its error code says why.

import { connect, type ConnectionOptions } from 'node:tls';

/** The server's own certificate for DICOM, and the authorities it trusts. All PEM. */
export interface DicomTls {
  /** The server's certificate, with any between it and its authority after it. */
  readonly cert: string;
  readonly key: string;
  /**
   * The authorities whose certificates other systems are trusted by. With
   * it, a system that calls must show a certificate of theirs, and a system
   * that is called must have one; without it, a system that is called is
   * trusted by the authorities the machine knows, and one that calls is
   * asked for none.
   */
  readonly ca: string | null;
}

/** What the server brings to a call over TLS. */
export interface ClientTls {
  /** The authorities to trust in place of those the machine knows. */
  readonly ca?: string;
  /** The server's own certificate and key, for a system that asks who calls. */
  readonly cert?: string;
  readonly key?: string;
}

/** What the server brings to a call, of what it was given for DICOM; a call needs none of it. */
export function clientTls(tls: DicomTls | null): ClientTls {
  if (tls === null) return {};
  return { cert: tls.cert, key: tls.key, ...(tls.ca === null ? {} : { ca: tls.ca }) };
}

/** The oldest TLS the server speaks, as for HTTPS. */
export const TLS_MIN_VERSION = 'TLSv1.2';

/** The library's options for a call over TLS: the other system's certificate is always checked. */
export function securityOptions(tls: ClientTls): Record<string, unknown> {
  return { ...tls, rejectUnauthorized: true, minVersion: TLS_MIN_VERSION };
}

/**
 * Why a call over TLS could not be made:
 *
 * - `tls-untrusted`: the other system's certificate is of no authority the
 *   server trusts (or is its own authority)
 * - `tls-expired`: its certificate's time has passed, or has not come
 * - `tls-name`: its certificate is for another name than it was called by
 * - `tls-refused`: it ended the connection as the handshake was made: it
 *   wants a certificate of this server's, or does not accept the one it has
 * - `tls-failed`: no handshake could be made: it may not speak TLS there,
 *   or it ended the handshake without saying why
 */
export const TLS_FAILURES = [
  'tls-untrusted',
  'tls-expired',
  'tls-name',
  'tls-refused',
  'tls-failed',
] as const;
export type TlsFailure = (typeof TLS_FAILURES)[number];

const UNTRUSTED = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'INVALID_CA',
]);
/** No connection at all: not a matter of TLS. */
const NO_CONNECTION = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
]);

/** What an error of a TLS connection says went wrong; null when it is not a matter of TLS. */
export function tlsFailureOf(error: unknown, secure: boolean): TlsFailure | null {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (NO_CONNECTION.has(code)) return null;
  if (UNTRUSTED.has(code)) return 'tls-untrusted';
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return 'tls-expired';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls-name';
  // An alert is the other side saying no: to our certificate, or to our having none.
  if (/_ALERT_/.test(code)) return 'tls-refused';
  // Ended once the handshake was made: the other side's refusal, as TLS 1.3 tells it.
  if (secure) return code === 'ECONNRESET' || code === 'EPIPE' ? 'tls-refused' : null;
  return 'tls-failed';
}

/** How long a handshake is waited for at most, when an address is asked what is wrong. */
const HANDSHAKE_WAIT_MS = 5_000;

/** How long the other side is given to say no once the handshake is made. */
const REFUSAL_WAIT_MS = 500;

/**
 * Ask an address for a TLS handshake and nothing more, and say what is wrong
 * with it; null when nothing is, or when what is wrong is not a matter of
 * TLS (nothing listens there). Resolves in every case.
 */
export function tlsProblem(
  target: { readonly host: string; readonly port: number; readonly tls: ClientTls },
  timeoutMs = HANDSHAKE_WAIT_MS,
): Promise<TlsFailure | null> {
  return new Promise((resolve) => {
    let secure = false;
    let settled = false;
    const options: ConnectionOptions = {
      host: target.host,
      port: target.port,
      ...securityOptions(target.tls),
    };
    const socket = connect(options);
    const settle = (problem: TlsFailure | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(late);
      socket.destroy();
      resolve(problem);
    };
    const late = setTimeout(() => settle(secure ? null : 'tls-failed'), timeoutMs);
    late.unref();
    socket.once('secureConnect', () => {
      secure = true;
      // TLS 1.3 has a client learn that its certificate is refused after
      // its own handshake is made, so a little is waited for.
      setTimeout(() => settle(null), REFUSAL_WAIT_MS).unref();
    });
    socket.once('error', (error) => settle(tlsFailureOf(error, secure)));
    // Ended by the other side with no error. Before the handshake:
    // something is there that does not speak TLS. Right after it, with
    // nothing said: it would not have this server.
    socket.once('close', () => settle(secure ? 'tls-refused' : 'tls-failed'));
  });
}

/**
 * What came of a call, with why when it came to nothing over TLS: a call
 * that found nothing there or broke is asked after once ({@link tlsProblem}).
 */
export async function withTlsProblem<R extends { readonly outcome: string }>(
  target: { readonly host: string; readonly port: number; readonly tls?: ClientTls },
  result: R,
  timeoutMs?: number,
): Promise<R | { readonly outcome: TlsFailure }> {
  if (target.tls === undefined) return result;
  if (result.outcome !== 'unreachable' && result.outcome !== 'broken') return result;
  const problem = await tlsProblem(
    { host: target.host, port: target.port, tls: target.tls },
    Math.min(timeoutMs ?? HANDSHAKE_WAIT_MS, HANDSHAKE_WAIT_MS),
  );
  return problem === null ? result : { outcome: problem };
}
