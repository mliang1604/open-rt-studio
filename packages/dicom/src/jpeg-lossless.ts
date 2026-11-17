/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The package ships no types. See wasm-codecs.ts for why this is a reference.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./codecs.d.ts" />

// JPEG Lossless (ITU-T T.81 process 14: predictive, Huffman), which DICOM
// holds under two transfer syntaxes. The decoder is jpeg-lossless-decoder-js,
// loaded on first use like the wasm codecs.
//
// Tried on streams from an encoder written from the standard
// (packages/testdata), it decodes exactly, with three exceptions, each of
// which gave wrong samples and no error. So this module does not hand it
// those:
//
// - When the coded data ends on a byte boundary and the last difference is 0,
//   the last pixel is left out: the decoder takes the end-of-image marker
//   before it uses the last code. Such a stream is decoded again with a byte
//   of fill bits before the marker ({@link withFillBeforeEnd}), which gives
//   the decoder what it wants.
// - With restart markers, the line after one is predicted wrongly for
//   predictors 2 to 7, and now and then for predictor 1. Refused.
// - Predictor 7 at 16 bits: a half is rounded the wrong way when the sum
//   wraps round. Refused.
//
// A point transform, and colour with more than 8 bits a sample, are refused
// too: not tried, so not trusted.

import { jpegFrameHeader, jpegScanHeader } from './jpeg-header.js';
import type { DecodedFrame } from './wasm-codecs.js';

const SYNTAXES = new Set([
  '1.2.840.10008.1.2.4.57', // JPEG Lossless, Non-Hierarchical (Process 14)
  '1.2.840.10008.1.2.4.70', // JPEG Lossless, First-Order Prediction (Selection Value 1)
]);

/** The lossless Huffman frame marker, SOF3. */
const SOF3 = 0xc3;

/** True for DICOM's two JPEG Lossless transfer syntaxes. */
export function isJpegLosslessSyntax(transferSyntax: string): boolean {
  return SYNTAXES.has(transferSyntax);
}

/**
 * Why a JPEG Lossless stream is one this package does not decode, in words
 * for the person who imported it; null when there is no such reason. A
 * stream that is not JPEG Lossless at all gets null here and fails in
 * {@link decodeJpegLosslessFrame}.
 */
export function jpegLosslessProblem(frame: Uint8Array): string | null {
  const header = jpegFrameHeader(frame);
  const scan = jpegScanHeader(frame);
  if (!header || !scan || header.marker !== SOF3) return null;
  if (scan.restartInterval !== 0) return 'JPEG Lossless with restart markers is not supported';
  if (scan.pointTransform !== 0) return 'JPEG Lossless with a point transform is not supported';
  if (scan.predictor === 7 && header.precision === 16) {
    return 'JPEG Lossless with predictor 7 at 16 bits is not supported';
  }
  const colour = header.components === 3 && header.precision <= 8;
  if (header.components !== 1 && !colour) {
    return `JPEG Lossless with ${header.components} components of ${header.precision} bits is not supported`;
  }
  return null;
}

/** Where the stream's end-of-image marker is. Throws when it has none. */
function endOfImage(stream: Uint8Array): number {
  let end = stream.length - 2;
  while (end >= 0 && !(stream[end] === 0xff && stream[end + 1] === 0xd9)) end--;
  if (end < 0) throw new Error('The JPEG stream has no end of image');
  return end;
}

/**
 * The stream with one byte of fill bits (0xFF, and the zero that must follow
 * it) put before its end-of-image marker, and nothing after the marker.
 * Throws when there is no such marker.
 */
export function withFillBeforeEnd(stream: Uint8Array): Uint8Array {
  const end = endOfImage(stream);
  const filled = new Uint8Array(end + 4);
  filled.set(stream.subarray(0, end));
  filled.set([0xff, 0x00, 0xff, 0xd9], end);
  return filled;
}

let decoderClass: Promise<typeof import('jpeg-lossless-decoder-js').Decoder> | null = null;

/**
 * Decode one JPEG Lossless frame. `bytesPerSample` is what the DICOM header
 * allocates, 1 or 2; 16-bit samples come back as little-endian bytes, like
 * the wasm codecs' output. Throws for a stream that is not JPEG Lossless,
 * one {@link jpegLosslessProblem} names, or one that ends before the image
 * does.
 */
export async function decodeJpegLosslessFrame(
  encoded: Uint8Array,
  bytesPerSample: 1 | 2,
): Promise<DecodedFrame> {
  const header = jpegFrameHeader(encoded);
  if (!header || header.marker !== SOF3) throw new Error('Not a JPEG Lossless stream');
  if (header.precision > 8 * bytesPerSample) {
    throw new Error('The JPEG stream has more bits a sample than the image allocates');
  }
  const problem = jpegLosslessProblem(encoded);
  if (problem) throw new Error(problem);

  // A stream cut short has no end of image. The decoder would read on past
  // the end of it, decode nothing as differences of 0, and not say so.
  const whole = encoded.subarray(0, endOfImage(encoded) + 2);

  decoderClass ??= import('jpeg-lossless-decoder-js').then((m) => m.Decoder);
  const Decoder = await decoderClass;
  const run = (stream: Uint8Array) => {
    const decoder = new Decoder();
    const samples = decoder.decode(
      stream.buffer as ArrayBuffer,
      stream.byteOffset,
      stream.length,
      bytesPerSample,
    );
    const asked = decoder.stream?.index ?? 0;
    const missing =
      asked > stream.length
        ? Infinity
        : (header.rows - decoder.yLoc) * header.columns - decoder.xLoc;
    return { samples, missing };
  };
  let { samples, missing } = run(whole);
  // The last pixel alone left out is the decoder's doing, not the stream's.
  if (missing === 1) ({ samples, missing } = run(withFillBeforeEnd(whole)));
  if (missing !== 0) throw new Error('The JPEG stream ends before the image does');
  return {
    bytes: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    bitsPerSample: 8 * bytesPerSample,
    componentCount: header.components,
  };
}
