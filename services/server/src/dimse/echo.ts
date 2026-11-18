/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// C-ECHO as the one who asks: is another system there, and does it let this
// server in?

import { CEchoRequest, Client } from './library.js';
import { securityOptions, withTlsProblem, type ClientTls, type TlsFailure } from './tls.js';

export interface EchoTarget {
  readonly host: string;
  readonly port: number;
  /** The AE title of the system asked. */
  readonly calledAeTitle: string;
  /** The AE title this server gives as its own. */
  readonly callingAeTitle: string;
  /** How long to wait for the connection and for each answer. Default 10 seconds. */
  readonly timeoutMs?: number;
  /** Call with TLS, with this; without, the call is not encrypted. */
  readonly tls?: ClientTls;
}

/**
 * What came of a C-ECHO:
 *
 * - `ok`: the other system answered with success
 * - `rejected`: it is there and refused the association (an AE title it does
 *   not know, most often)
 * - `unreachable`: no connection could be made: nothing listens there
 * - `broken`: the connection was made and no answer came: it was ended, or
 *   nothing came in time. A system that expects TLS does this to a call
 *   without.
 * - `failed`: it answered the echo with a status that is not success
 * - one of {@link TlsFailure}: no secure connection could be made, and why
 */
export type EchoResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'rejected' | 'unreachable' | 'broken' | TlsFailure }
  | { readonly outcome: 'failed'; readonly status: number };

/** Ask another system for a C-ECHO. Resolves in every case; it does not reject. */
export async function dicomEcho(target: EchoTarget): Promise<EchoResult> {
  const timeoutMs = target.timeoutMs ?? 10_000;
  return new Promise<EchoResult>((resolve) => {
    let result: EchoResult = { outcome: 'unreachable' };
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const client = new Client();
    const request = new CEchoRequest();
    request.on('response', (response: { getStatus(): number }) => {
      const status = response.getStatus();
      result = status === 0 ? { outcome: 'ok' } : { outcome: 'failed', status };
    });
    client.addRequest(request);
    client.on('associationRejected', () => {
      result = { outcome: 'rejected' };
    });
    client.on('connected', () => {
      // Something is there; what it answers, if it does, is said in place of this.
      if (result.outcome === 'unreachable') result = { outcome: 'broken' };
    });
    client.on('networkError', settle);
    client.on('closed', settle);
    client.send(target.host, target.port, target.callingAeTitle, target.calledAeTitle, {
      connectTimeout: timeoutMs,
      associationTimeout: timeoutMs,
      pduTimeout: timeoutMs,
      ...(target.tls ? { securityOptions: securityOptions(target.tls) } : {}),
    });
  }).then((result) => withTlsProblem(target, result, timeoutMs));
}
