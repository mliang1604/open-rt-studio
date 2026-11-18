/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A retrieve as another system asks for one (#52): the instances it named
// go out a few at a time, by C-MOVE to a third system or by C-GET back to
// the one that asked, and what became of each is counted. How a part is
// sent is the caller's; the counting and the bounds are here.

import type { Pacs } from '../core/core.js';
import type { OutgoingObject } from './part10.js';
import { takePart, type PartLimits } from './parts.js';
import type { SendOutcome } from './send.js';

/** What became of one instance of a retrieve. */
export type SubOperation = 'completed' | 'warning' | 'failed';

/** The counts a C-MOVE or C-GET is answered with. */
export interface RetrieveCounts {
  readonly remaining: number;
  readonly completed: number;
  readonly warning: number;
  readonly failed: number;
}

/**
 * Send one part, and say what became of each object in the order given.
 * Null when nothing more can be sent: the rest is not tried.
 */
export type PartSender = (objects: readonly OutgoingObject[]) => Promise<SubOperation[] | null>;

export interface RetrieveOptions {
  readonly pacs: Pacs;
  /** The SOP Instance UIDs to send, in order. */
  readonly instances: readonly string[];
  readonly limits: PartLimits;
  readonly sendPart: PartSender;
  /** Told the counts after each part while more remains. */
  readonly progress: (counts: RetrieveCounts) => void;
  /** Asked before each part: true ends the retrieve with the rest not sent. */
  readonly cancelled: () => boolean;
}

export interface RetrieveResult {
  /** `remaining` is what was not tried because the retrieve was cancelled. */
  readonly counts: RetrieveCounts;
  /** The instances that were not sent. */
  readonly failed: string[];
  readonly cancelled: boolean;
}

/** The statuses a retrieve ends with (PS3.4, C.4.2.1.5 and C.4.3.1.5). */
export const RETRIEVE_STATUS = {
  success: 0x0000,
  pending: 0xff00,
  cancelled: 0xfe00,
  /** Done, with one or more that failed or were stored with a warning. */
  someFailed: 0xb000,
  /** Out of resources: more instances than one retrieve sends. */
  tooMany: 0xa701,
  /** Nothing could be sent. */
  noneSent: 0xa702,
  destinationUnknown: 0xa801,
  identifierMismatch: 0xa900,
  unableToProcess: 0xc000,
} as const;

/** Run a retrieve to its end. Resolves in every case. */
export async function runRetrieve(options: RetrieveOptions): Promise<RetrieveResult> {
  const waiting = [...options.instances];
  const failed: string[] = [];
  let [completed, warning] = [0, 0];
  let cancelled = false;
  const counts = (): RetrieveCounts => ({
    remaining: waiting.length,
    completed,
    warning,
    failed: failed.length,
  });
  while (waiting.length > 0) {
    if (options.cancelled()) {
      cancelled = true;
      break;
    }
    const { objects, missing } = await takePart(options.pacs, waiting, options.limits);
    failed.push(...missing);
    const became = objects.length > 0 ? await options.sendPart(objects) : [];
    if (became === null) {
      // Nothing answers any more: what was not sent has failed.
      failed.push(...objects.map((object) => object.sopInstanceUid), ...waiting.splice(0));
      break;
    }
    objects.forEach((object, i) => {
      const one = became[i] ?? 'failed';
      if (one === 'completed') completed += 1;
      else if (one === 'warning') warning += 1;
      else failed.push(object.sopInstanceUid);
    });
    if (waiting.length > 0) options.progress(counts());
  }
  return { counts: counts(), failed, cancelled };
}

/** The status a retrieve that ran ends with. */
export function retrieveStatus(result: RetrieveResult): number {
  if (result.cancelled) return RETRIEVE_STATUS.cancelled;
  const { completed, warning, failed } = result.counts;
  if (failed === 0 && warning === 0) return RETRIEVE_STATUS.success;
  if (completed === 0 && warning === 0) return RETRIEVE_STATUS.noneSent;
  return RETRIEVE_STATUS.someFailed;
}

/**
 * What a C-STORE to another system came to, as a sub-operation of a move.
 * Null for an association that carried nothing at all, after which the
 * rest of the move is not tried.
 */
export function moved(outcomes: readonly SendOutcome[]): SubOperation[] | null {
  const answered = outcomes.some((one) => one.outcome === 'stored' || one.outcome === 'refused');
  const first = outcomes[0]?.outcome;
  if (!answered && (first === 'rejected' || first === 'unreachable' || first === 'broken')) {
    return null;
  }
  return outcomes.map((one) =>
    one.outcome !== 'stored' ? 'failed' : one.status === 0 ? 'completed' : 'warning',
  );
}
