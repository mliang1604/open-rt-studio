/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server asking another system (#51): what it holds (C-FIND), and to
// send a study or a series here (C-MOVE, with this server's own listener as
// the destination). Each is one association, made with the library's
// client. Neither rejects: what went wrong is the answer.

import {
  ASK_MATCHES_AT_MOST,
  askIdentifier,
  matchOf,
  type AskFailure,
  type AskKeys,
  type AskLevel,
  type MatchOf,
} from './ask-keys.js';
import {
  CFindRequest,
  Client,
  CMoveRequest,
  Dataset,
  PresentationContextResult,
  type LibraryAssociation,
} from './library.js';
import type { Identifier } from './query.js';
import type { SendTarget } from './send.js';
import { securityOptions, withTlsProblem } from './tls.js';

const PATIENT_ROOT = '1.2.840.10008.5.1.4.1.2.1';
const STUDY_ROOT = '1.2.840.10008.5.1.4.1.2.2';

export * from './ask-keys.js';

/** Whether an association has an accepted context for a SOP class. */
function takes(association: LibraryAssociation, sopClassUid: string): boolean {
  return association
    .getPresentationContexts()
    .some(
      ({ context }) =>
        context.getAbstractSyntaxUid() === sopClassUid &&
        context.getResult() === PresentationContextResult.Accept,
    );
}

const PENDING = new Set([0xff00, 0xff01]);
const CANCELLED = 0xfe00;

export type FindAnswer<L extends AskLevel> =
  | {
      readonly outcome: 'answered';
      /** The status the answer ended with: 0 for success. */
      readonly status: number;
      readonly matches: MatchOf[L][];
      /**
       * False when the list is not all there was: more matches than are
       * taken, or an answer that did not end in success.
       */
      readonly complete: boolean;
    }
  | { readonly outcome: AskFailure };

/** Ask another system for the patients, studies or series that match. */
export function findAt<L extends AskLevel>(
  target: SendTarget,
  level: L,
  keys: AskKeys,
  atMost: number = ASK_MATCHES_AT_MOST,
): Promise<FindAnswer<L>> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const sopClassUid = `${level === 'patient' ? PATIENT_ROOT : STUDY_ROOT}.1`;
  return new Promise<FindAnswer<L>>((resolve) => {
    const client = new Client();
    const request = new CFindRequest();
    request.setAffectedSopClassUid(sopClassUid);
    request.setDataset(new Dataset(askIdentifier(level, keys)));
    const matches: MatchOf[L][] = [];
    let status: number | null = null;
    let cut = false;
    let connected = false;
    let rejected = false;
    let taken = true;
    request.on('response', (response: unknown) => {
      const one = response as {
        getStatus(): number;
        getDataset(): { getElements(): Identifier } | undefined;
      };
      const answered = one.getStatus();
      if (!PENDING.has(answered)) {
        status = answered;
        return;
      }
      if (matches.length >= atMost) {
        // Enough: it is told to stop, once.
        if (!cut) client.cancel(request);
        cut = true;
        return;
      }
      const match = matchOf(level, one.getDataset()?.getElements() ?? {});
      if (match) matches.push(match);
    });
    client.addRequest(request);

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (status !== null) {
        resolve({
          outcome: 'answered',
          status,
          matches,
          complete: !cut && status === 0,
        });
      } else if (rejected) resolve({ outcome: 'rejected' });
      else if (!connected) resolve({ outcome: 'unreachable' });
      else if (!taken) resolve({ outcome: 'not-taken' });
      else if (cut) {
        // Cancelled, and the other system ended without saying so.
        resolve({ outcome: 'answered', status: CANCELLED, matches, complete: false });
      } else resolve({ outcome: 'broken' });
    };
    client.on('connected', () => {
      connected = true;
    });
    client.on('associationAccepted', (association: LibraryAssociation) => {
      taken = takes(association, sopClassUid);
    });
    client.on('associationRejected', () => {
      rejected = true;
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

/** How far a move is, as the other system tells it. */
export interface MoveCounts {
  readonly remaining: number;
  readonly completed: number;
  readonly failed: number;
  readonly warning: number;
}

export type MoveAnswer =
  | {
      readonly outcome: 'answered';
      /** The status the move ended with: 0 for success. */
      readonly status: number;
      /** The counts of the last answer that had any. */
      readonly counts: MoveCounts | null;
    }
  | { readonly outcome: AskFailure };

/** What of a study to have sent: all of it, or one series. */
export interface MoveOf {
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid?: string;
}

/**
 * Ask another system to send a study, or a series of one, to the system of
 * an AE title, which is this server when it is its own. The objects arrive
 * at that system's listener and not here; this hears how far it is.
 *
 * An association that hears nothing for `timeoutMs` ends as `broken`,
 * while the other system may still be sending.
 */
export function moveFrom(
  target: SendTarget,
  destinationAeTitle: string,
  what: MoveOf,
  progress: (counts: MoveCounts) => void = () => undefined,
): Promise<MoveAnswer> {
  const timeoutMs = target.timeoutMs ?? 120_000;
  const sopClassUid = `${STUDY_ROOT}.2`;
  return new Promise<MoveAnswer>((resolve) => {
    const client = new Client();
    const request = new CMoveRequest();
    request.setAffectedSopClassUid(sopClassUid);
    request.setDataset(
      new Dataset(
        what.seriesInstanceUid === undefined
          ? { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: what.studyInstanceUid }
          : {
              QueryRetrieveLevel: 'SERIES',
              StudyInstanceUID: what.studyInstanceUid,
              SeriesInstanceUID: what.seriesInstanceUid,
            },
      ),
    );
    request.getCommandDataset().setElement('MoveDestination', destinationAeTitle);
    let status: number | null = null;
    let counts: MoveCounts | null = null;
    let connected = false;
    let rejected = false;
    let taken = true;
    request.on('response', (response: unknown) => {
      const one = response as {
        getStatus(): number;
        getCommandDataset(): { getElement(name: string): unknown };
      };
      const answered = one.getStatus();
      const command = one.getCommandDataset();
      const number = (name: string): number | null => {
        const value = command.getElement(`NumberOf${name}Suboperations`);
        return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
      };
      const [completed, failed, warning] = [
        number('Completed'),
        number('Failed'),
        number('Warning'),
      ];
      if (completed !== null || failed !== null || warning !== null) {
        counts = {
          // An answer that ends a move has nothing remaining, unless it was
          // cancelled: the library's client reads the last one's there.
          remaining:
            PENDING.has(answered) || answered === CANCELLED ? (number('Remaining') ?? 0) : 0,
          completed: completed ?? 0,
          failed: failed ?? 0,
          warning: warning ?? 0,
        };
      }
      if (PENDING.has(answered)) {
        if (counts) progress(counts);
      } else {
        status = answered;
      }
    });
    client.addRequest(request);

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (status !== null) resolve({ outcome: 'answered', status, counts });
      else if (rejected) resolve({ outcome: 'rejected' });
      else if (!connected) resolve({ outcome: 'unreachable' });
      else if (!taken) resolve({ outcome: 'not-taken' });
      else resolve({ outcome: 'broken' });
    };
    client.on('connected', () => {
      connected = true;
    });
    client.on('associationAccepted', (association: LibraryAssociation) => {
      taken = takes(association, sopClassUid);
    });
    client.on('associationRejected', () => {
      rejected = true;
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
