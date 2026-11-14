/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

import {
  parseFileAsync,
  parseSpatialRegistration,
  parseStructureSet,
  UnsupportedDicomError,
  type Slice,
  type SpatialRegistration,
  type StructureSet,
} from '@open-rt-studio/dicom';

/**
 * A request to parse one file: the file's bytes plus the id used to pair the
 * response with its caller. The {@link buffer} is transferred in (not copied),
 * so the main thread must not reuse it after posting.
 */
export interface ParseRequest {
  readonly id: number;
  readonly name: string;
  readonly buffer: ArrayBuffer;
}

/**
 * The result of one {@link ParseRequest}: the parsed image slices and structure
 * sets on success, or on failure why the file could not be read (the worker
 * never throws across the boundary). `message` names the file; `reason` is the
 * same without the name. On success each slice's pixel buffer is transferred
 * back, not copied. `structureSets` holds the file's RTSTRUCT when it is one
 * (its contour points carry no pixel buffers, so they are cloned, not
 * transferred); empty otherwise. `registrations` likewise holds the file's
 * Spatial Registration object when it is one.
 */
export type ParseResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly slices: Slice[];
      readonly structureSets: StructureSet[];
      readonly registrations: SpatialRegistration[];
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly message: string;
      readonly reason: string;
    };

/**
 * Thin off-main-thread wrapper around the pure parsers: parse one file per
 * message and post its slices (and any RTSTRUCT) back, transferring the pixel
 * buffers so the large arrays move without a copy. An RTSTRUCT carries no
 * PixelData, so {@link parseFileAsync} yields no slices for it; only then do we
 * try {@link parseStructureSet}, which returns null for ordinary images. All
 * parsing/decoding logic stays in `../dicom`; this file is only the worker
 * plumbing.
 */
addEventListener('message', async (event: MessageEvent<ParseRequest>) => {
  const { id, name, buffer } = event.data;
  try {
    const slices = await parseFileAsync(name, buffer);
    const structureSet = slices.length === 0 ? parseStructureSet(name, buffer) : null;
    const structureSets = structureSet ? [structureSet] : [];
    // Neither an image nor a structure set: a registration object, perhaps.
    const registration =
      slices.length === 0 && !structureSet ? parseSpatialRegistration(buffer) : null;
    const registrations = registration ? [registration] : [];
    // Transfer each frame's pixel buffer back instead of cloning it.
    const transfer = slices.map((slice) => slice.pixels.buffer);
    postMessage(
      { id, ok: true, slices, structureSets, registrations } satisfies ParseResponse,
      transfer,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof UnsupportedDicomError ? error.reason : message;
    postMessage({ id, ok: false, message, reason } satisfies ParseResponse);
  }
});
