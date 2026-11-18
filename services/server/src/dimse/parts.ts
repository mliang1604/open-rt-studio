/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stored instances read a few at a time for sending, so that what a send or
// a retrieve holds in memory is bounded whatever the size of the series.

import type { Pacs } from '../core/core.js';
import { outgoingFrom, type OutgoingObject } from './part10.js';

/** How many instances are read, and sent on one association, at a time. */
export const INSTANCES_AT_ONCE = 25;
/** And how many bytes of them, unless one instance alone is more. */
export const BYTES_AT_ONCE = 64 * 1024 * 1024;

export interface PartLimits {
  readonly instancesAtOnce: number;
  readonly bytesAtOnce: number;
}

export interface Part {
  /** The instances that were read, as objects to send. */
  readonly objects: OutgoingObject[];
  /** The ones the store does not hold, or holds as something else. */
  readonly missing: string[];
}

/** A stored instance, read whole. Null when the store does not hold it. */
async function read(pacs: Pacs, sopInstanceUid: string): Promise<Uint8Array | null> {
  try {
    const pieces: Buffer[] = [];
    for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
    return Buffer.concat(pieces);
  } catch {
    return null;
  }
}

/**
 * Take the next few of the instances that wait off the front of the list
 * and read them: as many as fit the count and the bytes, and one at least.
 */
export async function takePart(pacs: Pacs, waiting: string[], limits: PartLimits): Promise<Part> {
  const objects: OutgoingObject[] = [];
  const missing: string[] = [];
  let bytes = 0;
  while (waiting.length > 0 && objects.length < limits.instancesAtOnce) {
    const size = (await pacs.store.stat(waiting[0]))?.size ?? 0;
    if (objects.length > 0 && bytes + size > limits.bytesAtOnce) break;
    const uid = waiting.shift()!;
    const file = await read(pacs, uid);
    const object = file ? outgoingFrom(file) : null;
    // Sent under the UID the server knows it by, which is the one it has.
    if (object && object.sopInstanceUid === uid) {
      objects.push(object);
      bytes += size;
    } else {
      missing.push(uid);
    }
  }
  return { objects, missing };
}
