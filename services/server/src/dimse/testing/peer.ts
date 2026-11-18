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
import {
  CFindRequest,
  CGetRequest,
  Client,
  CMoveRequest,
  CStoreRequest,
  CStoreResponse,
  Dataset,
  type LibraryStoreRequest,
  type LibraryStoreResponse,
} from '../library.js';
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

/** An identifier for the peer to ask with: attribute names to values. */
export type AskedIdentifier = Readonly<Record<string, unknown>>;

type AnyRequest =
  | InstanceType<typeof CFindRequest>
  | InstanceType<typeof CMoveRequest>
  | InstanceType<typeof CGetRequest>
  | InstanceType<typeof CStoreRequest>;

/** A C-FIND of an information model's SOP class. */
export function findRequest(sopClassUid: string, identifier: AskedIdentifier): AnyRequest {
  const request = new CFindRequest();
  request.setAffectedSopClassUid(sopClassUid);
  request.setDataset(new Dataset({ ...identifier }));
  return request;
}

/** A C-MOVE to the system of an AE title. */
export function moveRequest(
  sopClassUid: string,
  destinationAeTitle: string,
  identifier: AskedIdentifier,
): AnyRequest {
  const request = new CMoveRequest();
  request.setAffectedSopClassUid(sopClassUid);
  request.setDataset(new Dataset({ ...identifier }));
  request.getCommandDataset().setElement('MoveDestination', destinationAeTitle);
  return request;
}

/**
 * A C-GET. The library's client offers to take back the kinds of object it
 * knows, which are images: it has no way to offer another, so a structure
 * set, a plan, a dose or a registration is got back by getscu, in
 * dcmtk.spec.ts.
 */
export function getRequest(sopClassUid: string, identifier: AskedIdentifier): AnyRequest {
  const request = new CGetRequest();
  request.setAffectedSopClassUid(sopClassUid);
  request.setDataset(new Dataset({ ...identifier }));
  return request;
}

/** A C-STORE of a file on disk, to go on an association with other requests. */
export const storeRequest = (path: string): AnyRequest => new CStoreRequest(path);

/** One answer to a request: its status, and what else it says. */
export interface Answer {
  readonly status: number;
  /** The identifier it carries, as the library reads one; null when it carries none. */
  readonly identifier: Record<string, unknown> | null;
  /** The counts of a retrieve, where the answer has them. */
  readonly remaining: number | undefined;
  readonly completed: number | undefined;
  readonly failed: number | undefined;
  readonly warning: number | undefined;
}

export interface Conversation {
  /** The answers to each request, in the order the requests were given. */
  readonly answers: Answer[][];
  /** The objects the peer was sent on this association (C-GET), in the order they came. */
  readonly received: { sopClassUid: string; sopInstanceUid: string }[];
  readonly rejected: boolean;
  readonly broken: boolean;
}

export interface ConverseOptions extends SendOptions {
  /** The status the peer answers the nth object it is sent with; success unless given. */
  readonly storeStatus?: (nth: number) => number;
  /** Cancel the first request once it has had this many answers. */
  readonly cancelAfter?: number;
}

/** Make requests on one association with the library's client, and gather the answers. */
export async function converse(
  port: number,
  requests: readonly AnyRequest[],
  options: ConverseOptions = {},
): Promise<Conversation> {
  return new Promise((resolve) => {
    const client = new Client();
    const answers: Answer[][] = requests.map(() => []);
    const received: Conversation['received'] = [];
    let rejected = false;
    let broken = false;
    const count = (value: unknown): number | undefined =>
      typeof value === 'number' ? value : undefined;
    requests.forEach((request, i) => {
      request.on('response', (response: unknown) => {
        const one = response as {
          getStatus(): number;
          getDataset(): { getElements(): Record<string, unknown> } | undefined;
          getCommandDataset(): { getElement(name: string): unknown };
        };
        const command = one.getCommandDataset();
        answers[i].push({
          status: one.getStatus(),
          identifier: one.getDataset()?.getElements() ?? null,
          remaining: count(command.getElement('NumberOfRemainingSuboperations')),
          completed: count(command.getElement('NumberOfCompletedSuboperations')),
          failed: count(command.getElement('NumberOfFailedSuboperations')),
          warning: count(command.getElement('NumberOfWarningSuboperations')),
        });
        if (i === 0 && answers[0].length === options.cancelAfter) {
          client.cancel(request as InstanceType<typeof CGetRequest>);
        }
      });
      client.addRequest(request);
    });
    client.on(
      'cStoreRequest',
      (request: LibraryStoreRequest, callback: (response: LibraryStoreResponse) => void) => {
        received.push({
          sopClassUid: request.getAffectedSopClassUid(),
          sopInstanceUid: request.getAffectedSopInstanceUid(),
        });
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(options.storeStatus?.(received.length) ?? 0);
        callback(response);
      },
    );
    const done = (): void => resolve({ answers, received, rejected, broken });
    client.on('associationRejected', () => {
      rejected = true;
    });
    client.on('networkError', () => {
      broken = true;
      done();
    });
    client.on('closed', done);
    client.send(
      '127.0.0.1',
      port,
      options.callingAeTitle ?? PEER_AE,
      options.calledAeTitle ?? LISTENER_AE,
    );
  });
}
