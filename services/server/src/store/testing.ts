/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

/**
 * The SOP Instance UID (0008,0018) of a file written by
 * `@open-rt-studio/testdata`, which writes explicit VR little endian. Not a
 * DICOM parser: ingest (#45) reads files with `@open-rt-studio/dicom`.
 */
export function sopInstanceUidOf(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // After the 128-byte preamble and "DICM", look for tag (0008,0018) with VR "UI".
  for (let at = 132; at + 8 <= bytes.byteLength; at++) {
    if (
      view.getUint16(at, true) === 0x0008 &&
      view.getUint16(at + 2, true) === 0x0018 &&
      bytes[at + 4] === 0x55 && // U
      bytes[at + 5] === 0x49 // I
    ) {
      const length = view.getUint16(at + 6, true);
      const text = new TextDecoder().decode(bytes.subarray(at + 8, at + 8 + length));
      // A UID of odd length is padded with one NUL.
      return text.replace(/\0+$/, '');
    }
  }
  throw new Error('No SOP Instance UID found.');
}
