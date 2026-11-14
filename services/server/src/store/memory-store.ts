/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  assertUid,
  EmptyInstanceError,
  InstanceNotFoundError,
  piecesOf,
  type DicomStore,
  type StoredInstance,
} from './dicom-store.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * A store that keeps instances in memory and is gone with the process: for
 * tests, and for trying the server without a disk to write to.
 */
export function createMemoryStore(): DicomStore {
  const kept = new Map<string, { readonly bytes: Uint8Array; readonly instance: StoredInstance }>();

  const found = (sopInstanceUid: string) => {
    assertUid(sopInstanceUid);
    return kept.get(sopInstanceUid);
  };

  return {
    async put(sopInstanceUid, bytes) {
      assertUid(sopInstanceUid);
      const pieces: Uint8Array[] = [];
      // All of it is taken before anything is kept, so a failure changes nothing.
      for await (const piece of piecesOf(bytes)) pieces.push(piece.slice());
      const whole = Buffer.concat(pieces);
      if (whole.byteLength === 0) throw new EmptyInstanceError();
      const instance = { sopInstanceUid, size: whole.byteLength, sha256: sha256(whole) };
      kept.set(sopInstanceUid, { bytes: whole, instance });
      return instance;
    },

    async get(sopInstanceUid) {
      const entry = found(sopInstanceUid);
      if (!entry) throw new InstanceNotFoundError();
      return Readable.from([entry.bytes], { objectMode: false });
    },

    async stat(sopInstanceUid) {
      return found(sopInstanceUid)?.instance ?? null;
    },

    async exists(sopInstanceUid) {
      return found(sopInstanceUid) !== undefined;
    },

    async delete(sopInstanceUid) {
      assertUid(sopInstanceUid);
      return kept.delete(sopInstanceUid);
    },

    async verify(sopInstanceUid) {
      const entry = found(sopInstanceUid);
      if (!entry) throw new InstanceNotFoundError();
      return (
        entry.bytes.byteLength === entry.instance.size &&
        sha256(entry.bytes) === entry.instance.sha256
      );
    },
  };
}
