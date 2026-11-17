/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The sends a server has under way and has made (#50): a series, or one
// object of it, to another system, with what became of each instance.
//
// One send runs at a time and the rest wait their turn. A send reads its
// instances from the store a few at a time and sends each few on an
// association of its own, so that what it holds in memory is bounded
// whatever the length of the series. The records are kept while the server
// runs, the latest of them, and are gone when it stops.

import { randomBytes } from 'node:crypto';

import type { Pacs } from '../core/core.js';
import { SILENT_LOGGER, type Logger } from '../logger.js';
import { outgoingFrom, type OutgoingObject } from './part10.js';
// Types alone: the sender brings the DIMSE library, which is loaded by the first send.
import type { sendObjects, SendOutcome, SendTarget } from './send.js';

/** Why an instance did not arrive. */
export type SendFailure =
  /** The other system answered that it did not store it; `status` says with what. */
  | 'refused'
  /** The other system takes no object of this kind. */
  | 'kind-not-taken'
  /** The other system does not take the transfer syntax the object is stored in. */
  | 'transfer-syntax-not-taken'
  /** The association was refused. */
  | 'rejected'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** The connection ended before the instance was answered. */
  | 'broken'
  /** The server no longer holds the instance, or cannot read it as an object. */
  | 'missing'
  /** The server stopped before the instance was sent. */
  | 'stopped';

export interface SendInstance {
  readonly sopInstanceUid: string;
  readonly state: 'waiting' | 'sent' | 'failed';
  /** Of one that was sent: whether it went in another transfer syntax than it is stored in. */
  readonly rewritten: boolean;
  /** The status the other system answered with: a warning for one sent, the failure for one refused. */
  readonly status: number | null;
  readonly failure: SendFailure | null;
}

export interface SendRecord {
  readonly id: string;
  /** The system it goes to, as it was when the send was asked for. */
  readonly destination: { readonly id: string; readonly name: string; readonly aeTitle: string };
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly state: 'waiting' | 'running' | 'done';
  /** ISO 8601. */
  readonly askedAt: string;
  readonly finishedAt: string | null;
  /** The send whose failures this one sends again. */
  readonly retryOf: string | null;
  readonly instances: readonly SendInstance[];
}

export interface SendRequest {
  readonly destination: SendRecord['destination'];
  readonly target: SendTarget;
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly sopInstanceUids: readonly string[];
  readonly retryOf?: string;
}

export interface SendManagerOptions {
  readonly pacs: Pacs;
  readonly logger?: Logger;
  /** How many instances go on one association at most. */
  readonly instancesAtOnce?: number;
  /** How many bytes of instances are read for one association, the first of them apart. */
  readonly bytesAtOnce?: number;
  /** How many records are kept. */
  readonly kept?: number;
  /** In place of {@link sendObjects}, for a test. */
  readonly send?: typeof sendObjects;
}

export interface SendManager {
  /** Ask for a send. It is answered at once; the record says how it goes. */
  start(request: SendRequest): SendRecord;
  get(id: string): SendRecord | null;
  /** The records kept, the latest first. */
  list(): SendRecord[];
  /** The instances of a send that did not arrive. Null for a send there is none of. */
  failed(id: string): string[] | null;
  /** Resolves when no send is running or waiting. */
  idle(): Promise<void>;
  /** Let the send under way finish the association it is on, and send no more. */
  close(): Promise<void>;
}

export const SENDS_KEPT = 100;
const INSTANCES_AT_ONCE = 25;
const BYTES_AT_ONCE = 64 * 1024 * 1024;

const WAITING: Omit<SendInstance, 'sopInstanceUid'> = {
  state: 'waiting',
  rewritten: false,
  status: null,
  failure: null,
};

const failedAs = (failure: SendFailure, status: number | null = null) =>
  ({ state: 'failed', rewritten: false, status, failure }) as const;

/** What an instance's record says of what became of it on the association. */
function recorded(outcome: SendOutcome): Omit<SendInstance, 'sopInstanceUid'> {
  switch (outcome.outcome) {
    case 'stored':
      return {
        state: 'sent',
        rewritten: outcome.rewritten,
        status: outcome.status === 0 ? null : outcome.status,
        failure: null,
      };
    case 'refused':
      return failedAs('refused', outcome.status);
    case 'not-taken':
      return failedAs(outcome.why === 'kind' ? 'kind-not-taken' : 'transfer-syntax-not-taken');
    case 'rejected':
    case 'unreachable':
    case 'broken':
      return failedAs(outcome.outcome);
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

interface Held {
  record: SendRecord;
  readonly target: SendTarget;
}

export function createSendManager(options: SendManagerOptions): SendManager {
  const { pacs } = options;
  const logger = (options.logger ?? SILENT_LOGGER).child({ part: 'dicom' });
  const send: typeof sendObjects = async (target, objects) =>
    (options.send ?? (await import('./send.js')).sendObjects)(target, objects);
  const instancesAtOnce = options.instancesAtOnce ?? INSTANCES_AT_ONCE;
  const bytesAtOnce = options.bytesAtOnce ?? BYTES_AT_ONCE;
  const kept = options.kept ?? SENDS_KEPT;
  /** The records, the earliest first. */
  const held: Held[] = [];
  let closed = false;
  let turn: Promise<void> = Promise.resolve();

  /** Change what a send's record says of some of its instances. */
  const note = (
    one: Held,
    changes: ReadonlyMap<string, Omit<SendInstance, 'sopInstanceUid'>>,
    more: Partial<Pick<SendRecord, 'state' | 'finishedAt'>> = {},
  ): void => {
    one.record = {
      ...one.record,
      ...more,
      instances: one.record.instances.map((instance) => {
        const change = changes.get(instance.sopInstanceUid);
        return change ? { sopInstanceUid: instance.sopInstanceUid, ...change } : instance;
      }),
    };
  };

  /** A stored instance, read whole. Null when the store does not hold it. */
  const read = async (sopInstanceUid: string): Promise<Uint8Array | null> => {
    try {
      const pieces: Buffer[] = [];
      for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
      return Buffer.concat(pieces);
    } catch {
      return null;
    }
  };

  const run = async (one: Held): Promise<void> => {
    const started = Date.now();
    note(one, new Map(), { state: 'running' });
    const waiting = one.record.instances.map((instance) => instance.sopInstanceUid);
    /** Why nothing more is sent, once an association carried nothing at all. */
    let given: SendFailure | null = null;
    while (waiting.length > 0 && given === null && !closed) {
      // The next few: as many as fit the count and the bytes, and one at least.
      const objects: OutgoingObject[] = [];
      const changes = new Map<string, Omit<SendInstance, 'sopInstanceUid'>>();
      let bytes = 0;
      while (waiting.length > 0 && objects.length < instancesAtOnce) {
        const size = (await pacs.store.stat(waiting[0]))?.size ?? 0;
        if (objects.length > 0 && bytes + size > bytesAtOnce) break;
        const uid = waiting.shift()!;
        const file = await read(uid);
        const object = file ? outgoingFrom(file) : null;
        // Sent under the UID the server knows it by, which is the one it has.
        if (object && object.sopInstanceUid === uid) {
          objects.push(object);
          bytes += size;
        } else {
          changes.set(uid, failedAs('missing'));
        }
      }
      const outcomes = await send(one.target, objects);
      objects.forEach((object, i) => changes.set(object.sopInstanceUid, recorded(outcomes[i])));
      note(one, changes);
      // An association that answered nothing answers nothing the next time
      // either: the rest is not tried, and is said to have failed the same way.
      const answered = outcomes.some(
        (outcome) => outcome.outcome === 'stored' || outcome.outcome === 'refused',
      );
      const first = outcomes[0]?.outcome;
      if (!answered && (first === 'rejected' || first === 'unreachable' || first === 'broken')) {
        given = first;
      }
    }
    const rest = new Map(waiting.map((uid) => [uid, failedAs(given ?? 'stopped')] as const));
    note(one, rest, { state: 'done', finishedAt: new Date().toISOString() });
    const sent = one.record.instances.filter((instance) => instance.state === 'sent').length;
    logger.info('dicom-send', {
      instances: one.record.instances.length,
      sent,
      failed: one.record.instances.length - sent,
      ms: Date.now() - started,
    });
  };

  return {
    start(request) {
      const record: SendRecord = {
        id: randomBytes(8).toString('hex'),
        destination: request.destination,
        studyInstanceUid: request.studyInstanceUid,
        seriesInstanceUid: request.seriesInstanceUid,
        state: 'waiting',
        askedAt: new Date().toISOString(),
        finishedAt: null,
        retryOf: request.retryOf ?? null,
        instances: request.sopInstanceUids.map((sopInstanceUid) => ({
          sopInstanceUid,
          ...WAITING,
        })),
      };
      const one: Held = { record, target: request.target };
      held.push(one);
      // The earliest that are done make room; one that is not done is never dropped.
      for (let i = 0; held.length > kept && i < held.length;) {
        if (held[i].record.state === 'done') held.splice(i, 1);
        else i += 1;
      }
      turn = turn.then(() =>
        closed
          ? note(
              one,
              new Map(record.instances.map((i) => [i.sopInstanceUid, failedAs('stopped')])),
              { state: 'done', finishedAt: new Date().toISOString() },
            )
          : run(one).catch(() => {
              // A send that could not be carried out is done, with what it has.
              note(
                one,
                new Map(
                  one.record.instances
                    .filter((instance) => instance.state === 'waiting')
                    .map((instance) => [instance.sopInstanceUid, failedAs('broken')]),
                ),
                { state: 'done', finishedAt: new Date().toISOString() },
              );
              logger.error('dicom-send-failed');
            }),
      );
      return record;
    },
    get: (id) => held.find((one) => one.record.id === id)?.record ?? null,
    list: () => held.map((one) => one.record).reverse(),
    failed(id) {
      const record = held.find((one) => one.record.id === id)?.record;
      if (!record) return null;
      return record.instances
        .filter((instance) => instance.state === 'failed')
        .map((instance) => instance.sopInstanceUid);
    },
    idle: () => turn,
    close() {
      closed = true;
      return turn;
    },
  };
}
