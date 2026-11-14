/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a JPEG stream's frame header (its SOF marker) declares. Read without
 * decoding anything, to tell what a stream is before handing it to a codec.
 */
export interface JpegFrameHeader {
  /** The SOF marker's low byte: 0xC0 baseline, 0xC1 extended, 0xC3 lossless, … */
  readonly marker: number;
  /** Sample precision in bits: 8 or 12 for DCT-based JPEG, 2 to 16 for lossless. */
  readonly precision: number;
  readonly rows: number;
  readonly columns: number;
  readonly components: number;
}

/** SOF markers: 0xC0 to 0xCF, less DHT (C4), JPG (C8) and DAC (CC). */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Read the frame header of a JPEG stream: walk the marker segments from the
 * start of image to the first SOF. Returns null when the bytes are not a JPEG
 * stream, or end before a frame header.
 */
export function jpegFrameHeader(bytes: Uint8Array): JpegFrameHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // no SOI
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null; // not at a marker: not a segment structure
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++; // a fill byte before the marker
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // image or scan before a frame
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    if (isFrameMarker(marker)) {
      if (at + 10 > bytes.length) return null;
      return {
        marker,
        precision: bytes[at + 4],
        rows: (bytes[at + 5] << 8) | bytes[at + 6],
        columns: (bytes[at + 7] << 8) | bytes[at + 8],
        components: bytes[at + 9],
      };
    }
    at += 2 + length;
  }
  return null;
}
