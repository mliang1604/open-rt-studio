/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Two test servers as DICOM systems to each other: one that listens, and
// one that is told where the other is and sends to it. For servers started
// without an account, whose API asks for no login.

import { expect } from '@playwright/test';

import type { TestServer } from './server';

/** Ask a test server's API for something, as JSON. */
export async function serverApi<T>(
  server: TestServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.address}/api/v1${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** The data set of a file a server holds: what follows the preamble, `DICM` and the meta group. */
export async function storedDataSet(server: TestServer, sopInstanceUid: string): Promise<Buffer> {
  const response = await fetch(`${server.address}/api/v1/instances/${sopInstanceUid}/file`);
  expect(response.status, `the file of ${sopInstanceUid}`).toBe(200);
  const file = Buffer.from(await response.arrayBuffer());
  return file.subarray(144 + file.readUInt32LE(140));
}

/** Have a server listen for DICOM under an AE title and let one caller in. Gives its port. */
export async function listenForDicom(
  server: TestServer,
  aeTitle: string,
  callerAeTitle: string,
): Promise<number> {
  const state = await serverApi<{ listening: { port: number } }>(server, 'PUT', '/dicom/local', {
    enabled: true,
    port: 0,
    aeTitle,
  });
  await serverApi(server, 'POST', '/dicom/remotes', {
    name: 'The sender',
    aeTitle: callerAeTitle,
    host: null,
    port: null,
    mayStore: true,
    mayRetrieve: false,
  });
  return state.listening.port;
}

/** A send as a server records it, as far as the specs read it. */
export interface RecordedSend {
  readonly id: string;
  readonly state: string;
  readonly instances: readonly {
    readonly sopInstanceUid: string;
    readonly state: string;
    readonly failure: string | null;
  }[];
}

/** Ask a server for a send, and give its record once it is done. */
export async function sendAndWait(server: TestServer, what: unknown): Promise<RecordedSend> {
  const asked = await serverApi<RecordedSend>(server, 'POST', '/dicom/sends', what);
  let record = asked;
  await expect
    .poll(async () => {
      record = await serverApi<RecordedSend>(server, 'GET', `/dicom/sends/${asked.id}`);
      return record.state;
    })
    .toBe('done');
  return record;
}
