/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only: another system, as far as the listener can tell. It sends
// objects with the library's own client (the server's sending is #50), and
// makes a PACS in memory for a listener to feed.

import { createServer } from 'node:net';

import { createCore, type ServerCore } from '../../core/core.js';
import { openSqliteIndex } from '../../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../../store/memory-store.js';
import { Client, CStoreRequest } from '../library.js';
import { startDicomListener, type DicomListener, type DicomListenerOptions } from '../listener.js';

/** The AE title the test listener answers to, and the one it lets in. */
export const LISTENER_AE = 'ORS-TEST';
export const PEER_AE = 'PEER';

/** A port nothing is listening on, for a peer that has to be told one. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

export interface TestListener {
  readonly core: ServerCore;
  readonly listener: DicomListener;
  readonly port: number;
  close(): Promise<void>;
}

/** A listener on 127.0.0.1, on a port the system picks, feeding a PACS in memory. */
export async function startTestListener(
  options: Partial<Omit<DicomListenerOptions, 'pacs'>> = {},
): Promise<TestListener> {
  const core = createCore({
    pacs: { store: createMemoryStore(), index: await openSqliteIndex(':memory:') },
  });
  const listener = await startDicomListener({
    pacs: core.pacs!,
    host: '127.0.0.1',
    port: 0,
    aeTitle: LISTENER_AE,
    callers: [PEER_AE],
    maxObjectBytes: 64 * 1024 * 1024,
    ...options,
  });
  return {
    core,
    listener,
    port: listener.port,
    close: async () => {
      await listener.close();
      await core.dispose();
    },
  };
}

export interface SendOptions {
  readonly callingAeTitle?: string;
  readonly calledAeTitle?: string;
}

/** What came of an association the peer made to store files. */
export interface SendResult {
  /** The status of each C-STORE that was answered, in the order sent. */
  readonly statuses: number[];
  /** True when the association was refused. */
  readonly rejected: boolean;
  /** True when the connection failed or broke. */
  readonly broken: boolean;
}

/** C-STORE Part 10 files from disk on one association, with the library's client. */
export async function sendFiles(
  port: number,
  paths: readonly string[],
  options: SendOptions = {},
): Promise<SendResult> {
  return new Promise((resolve) => {
    const client = new Client();
    const statuses: number[] = [];
    let rejected = false;
    let broken = false;
    for (const path of paths) {
      const request = new CStoreRequest(path);
      request.on('response', (response: { getStatus(): number }) => {
        statuses.push(response.getStatus());
      });
      client.addRequest(request);
    }
    client.on('associationRejected', () => {
      rejected = true;
    });
    client.on('networkError', () => {
      broken = true;
      resolve({ statuses, rejected, broken });
    });
    client.on('closed', () => resolve({ statuses, rejected, broken }));
    client.send(
      '127.0.0.1',
      port,
      options.callingAeTitle ?? PEER_AE,
      options.calledAeTitle ?? LISTENER_AE,
    );
  });
}
