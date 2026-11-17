/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// C-ECHO as the one who asks: is another system there, and does it let this
// server in?

import { CEchoRequest, Client } from './library.js';

export interface EchoTarget {
  readonly host: string;
  readonly port: number;
  /** The AE title of the system asked. */
  readonly calledAeTitle: string;
  /** The AE title this server gives as its own. */
  readonly callingAeTitle: string;
  /** How long to wait for the connection and for each answer. Default 10 seconds. */
  readonly timeoutMs?: number;
}

/**
 * What came of a C-ECHO:
 *
 * - `ok`: the other system answered with success
 * - `rejected`: it is there and refused the association (an AE title it does
 *   not know, most often)
 * - `unreachable`: no association could be made: nothing listens there, the
 *   connection broke, or no answer came in time
 * - `failed`: it answered the echo with a status that is not success
 */
export type EchoResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'rejected' | 'unreachable' }
  | { readonly outcome: 'failed'; readonly status: number };

/** Ask another system for a C-ECHO. Resolves in every case; it does not reject. */
export async function dicomEcho(target: EchoTarget): Promise<EchoResult> {
  const timeoutMs = target.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
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
    client.on('networkError', settle);
    client.on('closed', settle);
    client.send(target.host, target.port, target.callingAeTitle, target.calledAeTitle, {
      connectTimeout: timeoutMs,
      associationTimeout: timeoutMs,
      pduTimeout: timeoutMs,
    });
  });
}
