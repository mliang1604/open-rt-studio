/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Readable } from 'node:stream';

/** What the store knows of an instance it holds. */
export interface StoredInstance {
  readonly sopInstanceUid: string;
  /** Bytes of the stored file. */
  readonly size: number;
  /** SHA-256 of the stored file, in lower-case hex. */
  readonly sha256: string;
}

/** The bytes of an instance: all at once, or in pieces as they arrive. */
export type InstanceBytes = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/**
 * Where DICOM instances are kept, one file's bytes per SOP Instance UID.
 *
 * The store keeps bytes and answers for their integrity. It does not read
 * them: what an instance is and what it belongs to is the index's business
 * (#43), and deciding whether an instance may replace another is ingest's
 * (#45).
 */
export interface DicomStore {
  /**
   * Keep these bytes as the instance. An instance already kept under the UID
   * is replaced, in one step: a reader gets the old bytes or the new ones.
   * Either the whole instance is stored or nothing changes: a failure
   * part-way leaves what was there before.
   */
  put(sopInstanceUid: string, bytes: InstanceBytes): Promise<StoredInstance>;
  /** The instance's bytes as a stream. Rejects with {@link InstanceNotFoundError}. */
  get(sopInstanceUid: string): Promise<Readable>;
  /** What is kept under the UID, or null. */
  stat(sopInstanceUid: string): Promise<StoredInstance | null>;
  exists(sopInstanceUid: string): Promise<boolean>;
  /** Remove the instance. False when there was none. */
  delete(sopInstanceUid: string): Promise<boolean>;
  /**
   * Read the instance back and compare it with the size and checksum taken
   * when it was stored. False means the bytes have changed since. Rejects with
   * {@link InstanceNotFoundError}.
   */
  verify(sopInstanceUid: string): Promise<boolean>;
}

/** Nothing is kept under this UID. */
export class InstanceNotFoundError extends Error {
  override readonly name = 'InstanceNotFoundError';
  constructor() {
    // The UID is left out: messages end up in logs.
    super('The store holds no instance with that SOP Instance UID.');
  }
}

/** The text is not a DICOM UID. */
export class InvalidUidError extends Error {
  override readonly name = 'InvalidUidError';
  constructor() {
    super('A SOP Instance UID is 1 to 64 characters: numbers separated by single dots.');
  }
}

/** An instance has bytes; none were given. */
export class EmptyInstanceError extends Error {
  override readonly name = 'EmptyInstanceError';
  constructor() {
    super('An instance with no bytes cannot be stored.');
  }
}

const UID = /^[0-9]+(\.[0-9]+)*$/;

/**
 * Whether the text has the form of a DICOM UID (PS3.5, 9.1): at most 64
 * characters, numeric components separated by dots. A component with a
 * leading zero is against the standard but is found in real files, and is
 * accepted.
 */
export function isUid(text: string): boolean {
  return text.length <= 64 && UID.test(text);
}

/** Throws {@link InvalidUidError} for anything that is not a UID. */
export function assertUid(text: string): void {
  if (typeof text !== 'string' || !isUid(text)) throw new InvalidUidError();
}

/** The pieces of an instance one after another, however they were given. */
export async function* piecesOf(bytes: InstanceBytes): AsyncGenerator<Uint8Array> {
  if (bytes instanceof Uint8Array) yield bytes;
  else yield* bytes;
}
