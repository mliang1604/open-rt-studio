/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The retrieves the server has asked other systems for (#51): one at a
// time, each a C-MOVE whose objects arrive at the server's own listener,
// and a record of each that says how far it is and how it ended.
//
// What a record counts is what the other system says it sent. What the
// server then holds of the study is counted beside it, from the index,
// since the two need not agree.
//
// The records are kept in memory: a server that stops forgets them, and a
// retrieve it was waiting on is not asked for again when it starts.

import { randomBytes } from 'node:crypto';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import type { AskFailure, MoveAnswer, MoveCounts, MoveOf, moveFrom } from './ask.js';
import type { SendTarget } from './send.js';

/** Why a retrieve brought nothing, or not all. */
export type RetrieveFailure =
  | AskFailure
  /** The other system does not know this server as a place to send to. */
  | 'destination-unknown'
  /** The other system ended the move otherwise than well; `status` says with what. */
  | 'refused'
  /** The server stopped before the retrieve was made. */
  | 'stopped';

export interface RetrieveRecord {
  readonly id: string;
  /** The system it is retrieved from, as it was when the retrieve was asked for. */
  readonly source: { readonly id: string; readonly name: string; readonly aeTitle: string };
  readonly studyInstanceUid: string;
  /** The one series that was asked for; null for the whole study. */
  readonly seriesInstanceUid: string | null;
  readonly state: 'waiting' | 'running' | 'done';
  /** ISO 8601. */
  readonly askedAt: string;
  readonly finishedAt: string | null;
  /** How far it is, as the other system tells it; null until it has. */
  readonly counts: MoveCounts | null;
  /**
   * How it ended: everything was sent, some of it was, or none. Null while
   * it is not done.
   */
  readonly result: 'retrieved' | 'partly' | 'failed' | null;
  readonly failure: RetrieveFailure | null;
  /** The status the other system ended the move with, where it did. */
  readonly status: number | null;
  /** The instances of the study, or of the series, the server holds once it is done. */
  readonly held: number | null;
}

export interface RetrieveRequest {
  readonly source: RetrieveRecord['source'];
  readonly target: SendTarget;
  /** The AE title the other system is to send to: this server's own. */
  readonly destinationAeTitle: string;
  readonly what: MoveOf;
  /** The account that asked for it; null where there is none. */
  readonly by?: string | null;
}

export interface RetrieveManagerOptions {
  readonly index: PacsIndex;
  readonly logger?: Logger;
  /** How many records are kept. */
  readonly kept?: number;
  /** In place of {@link moveFrom}, for a test. */
  readonly move?: typeof moveFrom;
  /** Told of each retrieve once it is done, however it ended, with who asked for it. */
  readonly ended?: (record: RetrieveRecord, by: string | null) => void;
}

export interface RetrieveManager {
  /** Ask for a retrieve. It is answered at once; the record says how it goes. */
  start(request: RetrieveRequest): RetrieveRecord;
  get(id: string): RetrieveRecord | null;
  /** The records kept, the latest first. */
  list(): RetrieveRecord[];
  /** Resolves when no retrieve is running or waiting. */
  idle(): Promise<void>;
  /** Let the retrieve under way end, and make no more. */
  close(): Promise<void>;
}

export const RETRIEVES_KEPT = 100;

const SUCCESS = 0x0000;
const SOME_FAILED = 0xb000;
const DESTINATION_UNKNOWN = 0xa801;

/** How a move's answer is recorded. */
export function ended(
  answer: MoveAnswer,
): Pick<RetrieveRecord, 'result' | 'failure' | 'status' | 'counts'> {
  if (answer.outcome !== 'answered') {
    return { result: 'failed', failure: answer.outcome, status: null, counts: null };
  }
  const { status, counts } = answer;
  if (status === SUCCESS) return { result: 'retrieved', failure: null, status, counts };
  // Done, with some that were not sent: what was sent is here.
  if (status === SOME_FAILED) return { result: 'partly', failure: null, status, counts };
  return {
    result: 'failed',
    failure: status === DESTINATION_UNKNOWN ? 'destination-unknown' : 'refused',
    status,
    counts,
  };
}

export function createRetrieveManager(options: RetrieveManagerOptions): RetrieveManager {
  const { index } = options;
  const logger = (options.logger ?? SILENT_LOGGER).child({ part: 'dicom' });
  const move: typeof moveFrom = async (...args) =>
    (options.move ?? (await import('./ask.js')).moveFrom)(...args);
  const kept = options.kept ?? RETRIEVES_KEPT;
  /** The records, the earliest first. */
  const held: { record: RetrieveRecord; readonly request: RetrieveRequest }[] = [];
  let closed = false;
  let turn: Promise<void> = Promise.resolve();

  const run = async (one: (typeof held)[number]): Promise<void> => {
    const started = Date.now();
    one.record = { ...one.record, state: 'running' };
    const { target, destinationAeTitle, what } = one.request;
    const answer = await move(target, destinationAeTitle, what, (counts) => {
      one.record = { ...one.record, counts };
    }).catch((): MoveAnswer => ({ outcome: 'broken' }));
    const how = ended(answer);
    const here = await index
      .findInstances({
        studyInstanceUid: what.studyInstanceUid,
        ...(what.seriesInstanceUid === undefined
          ? {}
          : { seriesInstanceUid: what.seriesInstanceUid }),
      })
      .then(
        (instances) => instances.length,
        () => null,
      );
    one.record = {
      ...one.record,
      ...how,
      counts: how.counts ?? one.record.counts,
      state: 'done',
      finishedAt: new Date().toISOString(),
      held: here,
    };
    logger.info('dicom-retrieve', {
      result: how.result,
      failure: how.failure ?? undefined,
      status: how.status ?? undefined,
      completed: one.record.counts?.completed ?? 0,
      failed: one.record.counts?.failed ?? 0,
      held: here ?? undefined,
      ms: Date.now() - started,
    });
  };

  return {
    start(request) {
      const record: RetrieveRecord = {
        id: randomBytes(8).toString('hex'),
        source: request.source,
        studyInstanceUid: request.what.studyInstanceUid,
        seriesInstanceUid: request.what.seriesInstanceUid ?? null,
        state: 'waiting',
        askedAt: new Date().toISOString(),
        finishedAt: null,
        counts: null,
        result: null,
        failure: null,
        status: null,
        held: null,
      };
      const one = { record, request };
      held.push(one);
      // The earliest that are done make room; one that is not done is never dropped.
      for (let i = 0; held.length > kept && i < held.length;) {
        if (held[i].record.state === 'done') held.splice(i, 1);
        else i += 1;
      }
      const carriedOut = async (): Promise<void> => {
        if (closed) {
          one.record = {
            ...one.record,
            state: 'done',
            finishedAt: new Date().toISOString(),
            result: 'failed',
            failure: 'stopped',
          };
          return;
        }
        try {
          await run(one);
        } catch (error) {
          logger.error('dicom-retrieve-failed', {
            errorName: error instanceof Error ? error.name : 'unknown',
          });
          one.record = {
            ...one.record,
            state: 'done',
            finishedAt: new Date().toISOString(),
            result: 'failed',
            failure: 'broken',
          };
        }
      };
      turn = turn.then(async () => {
        await carriedOut();
        try {
          options.ended?.(one.record, request.by ?? null);
        } catch {
          // What is told of a retrieve does not undo it.
        }
      });
      return record;
    },
    get: (id) => held.find((one) => one.record.id === id)?.record ?? null,
    list: () => held.map((one) => one.record).reverse(),
    idle: () => turn,
    close() {
      closed = true;
      return turn;
    },
  };
}
