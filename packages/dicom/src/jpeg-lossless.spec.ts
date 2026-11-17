/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment node

import {
  decodeJpegLosslessFrame,
  isJpegLosslessSyntax,
  jpegLosslessProblem,
  withFillBeforeEnd,
} from './jpeg-lossless.js';

// The streams here are worked out by hand from ITU-T T.81, not made by an
// encoder. The Huffman table gives the difference categories 0 to 16 the code
// lengths 2, 3, 3, 3, 3, 3, 4, 5, …, 14, so category 0 is `00` and category 1
// is `010`, followed by one bit: 1 for a difference of +1, 0 for -1.
const TABLE = [
  ...[0xff, 0xc4, 0, 36, 0x00], // DHT, table 0
  ...[0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0], // how many codes of each length
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], // the categories
];

interface Stream {
  readonly precision?: number;
  readonly rows?: number;
  readonly columns?: number;
  readonly components?: number;
  readonly sof?: number;
  readonly predictor?: number;
  readonly pointTransform?: number;
  readonly restartInterval?: number;
  readonly data: readonly number[];
  readonly end?: readonly number[];
}

function stream(s: Stream): Uint8Array {
  const n = s.components ?? 1;
  const ids = Array.from({ length: n }, (_, c) => c + 1);
  return Uint8Array.from([
    ...[0xff, 0xd8],
    ...[0xff, s.sof ?? 0xc3, 0, 8 + 3 * n, s.precision ?? 16],
    ...[0, s.rows ?? 2, 0, s.columns ?? 2, n, ...ids.flatMap((id) => [id, 0x11, 0])],
    ...TABLE,
    ...(s.restartInterval ? [0xff, 0xdd, 0, 4, 0, s.restartInterval] : []),
    ...[0xff, 0xda, 0, 6 + 2 * n, n, ...ids.flatMap((id) => [id, 0])],
    ...[s.predictor ?? 1, 0, s.pointTransform ?? 0],
    ...s.data,
    ...(s.end ?? [0xff, 0xd9]),
  ]);
}

/** Little-endian 16-bit samples out of decoded bytes. */
const words = (bytes: Uint8Array): number[] =>
  Array.from({ length: bytes.length / 2 }, (_, i) => bytes[2 * i] | (bytes[2 * i + 1] << 8));

describe('isJpegLosslessSyntax', () => {
  it('is true for the two JPEG Lossless transfer syntaxes and no other', () => {
    expect(isJpegLosslessSyntax('1.2.840.10008.1.2.4.57')).toBe(true);
    expect(isJpegLosslessSyntax('1.2.840.10008.1.2.4.70')).toBe(true);
    expect(isJpegLosslessSyntax('1.2.840.10008.1.2.4.50')).toBe(false); // JPEG Baseline
    expect(isJpegLosslessSyntax('1.2.840.10008.1.2.4.80')).toBe(false); // JPEG-LS
  });
});

describe('decodeJpegLosslessFrame', () => {
  it('decodes a stream worked out by hand', async () => {
    // 32768 32769    differences 0 (from 2^15), +1 (from the left),
    // 32767 32768                -1 (from above), +1 (from the left):
    // 00 0101 0100 0101, and two fill bits.
    const decoded = await decodeJpegLosslessFrame(stream({ data: [0b00010101, 0b00010111] }), 2);
    expect(words(decoded.bytes)).toEqual([32768, 32769, 32767, 32768]);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.componentCount).toBe(1);
  });

  it('keeps the last sample when the data ends on a byte boundary', async () => {
    // Four differences of 0 are eight bits exactly, with no fill bits. The
    // decoder alone leaves the last sample 0 here.
    const decoded = await decodeJpegLosslessFrame(stream({ data: [0x00] }), 2);
    expect(words(decoded.bytes)).toEqual([32768, 32768, 32768, 32768]);
  });

  it('gives 8-bit samples as bytes', async () => {
    const decoded = await decodeJpegLosslessFrame(
      stream({ precision: 8, data: [0b00010101, 0b00010111] }),
      1,
    );
    expect(Array.from(decoded.bytes)).toEqual([128, 129, 127, 128]);
    expect(decoded.bitsPerSample).toBe(8);
  });

  it('gives a stream of few bits the width the image allocates', async () => {
    const decoded = await decodeJpegLosslessFrame(stream({ precision: 8, data: [0x00] }), 2);
    expect(words(decoded.bytes)).toEqual([128, 128, 128, 128]);
  });

  it('refuses a stream with more bits a sample than the image allocates', async () => {
    await expect(decodeJpegLosslessFrame(stream({ data: [0x00] }), 1)).rejects.toThrow(
      /more bits a sample/,
    );
  });

  it('refuses a stream that is not JPEG Lossless', async () => {
    await expect(decodeJpegLosslessFrame(stream({ sof: 0xc0, data: [0x00] }), 2)).rejects.toThrow(
      'Not a JPEG Lossless stream',
    );
    await expect(decodeJpegLosslessFrame(Uint8Array.of(1, 2, 3, 4), 2)).rejects.toThrow(
      'Not a JPEG Lossless stream',
    );
  });

  it('refuses a stream cut short, which would otherwise decode to zeros', async () => {
    // No end of image.
    await expect(decodeJpegLosslessFrame(stream({ data: [0x00], end: [] }), 2)).rejects.toThrow(
      'The JPEG stream has no end of image',
    );
    // An end of image after two of the four samples.
    await expect(
      decodeJpegLosslessFrame(stream({ rows: 4, data: [0b00001111] }), 2),
    ).rejects.toThrow('The JPEG stream ends before the image does');
  });

  it('refuses what jpegLosslessProblem names', async () => {
    await expect(
      decodeJpegLosslessFrame(stream({ restartInterval: 2, data: [0x00] }), 2),
    ).rejects.toThrow('JPEG Lossless with restart markers is not supported');
  });
});

describe('jpegLosslessProblem', () => {
  it('finds none in a plain stream, of any predictor below 16 bits', () => {
    expect(jpegLosslessProblem(stream({ data: [0x00] }))).toBeNull();
    for (let predictor = 1; predictor <= 7; predictor++) {
      expect(jpegLosslessProblem(stream({ precision: 12, predictor, data: [0] }))).toBeNull();
    }
    expect(jpegLosslessProblem(stream({ predictor: 6, data: [0] }))).toBeNull();
    expect(jpegLosslessProblem(stream({ precision: 8, components: 3, data: [0] }))).toBeNull();
  });

  it('names restart markers, a point transform, and predictor 7 at 16 bits', () => {
    expect(jpegLosslessProblem(stream({ restartInterval: 2, data: [0] }))).toBe(
      'JPEG Lossless with restart markers is not supported',
    );
    expect(jpegLosslessProblem(stream({ pointTransform: 1, data: [0] }))).toBe(
      'JPEG Lossless with a point transform is not supported',
    );
    expect(jpegLosslessProblem(stream({ predictor: 7, data: [0] }))).toBe(
      'JPEG Lossless with predictor 7 at 16 bits is not supported',
    );
  });

  it('names colour of more than 8 bits, and component counts other than 1 and 3', () => {
    expect(jpegLosslessProblem(stream({ components: 3, data: [0] }))).toBe(
      'JPEG Lossless with 3 components of 16 bits is not supported',
    );
    expect(jpegLosslessProblem(stream({ precision: 8, components: 2, data: [0] }))).toBe(
      'JPEG Lossless with 2 components of 8 bits is not supported',
    );
  });

  it('leaves what is not a JPEG Lossless stream to the decoder', () => {
    expect(jpegLosslessProblem(stream({ sof: 0xc0, data: [0] }))).toBeNull();
    expect(jpegLosslessProblem(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
  });
});

describe('withFillBeforeEnd', () => {
  it('puts a stuffed byte of ones before the end of image', () => {
    expect(Array.from(withFillBeforeEnd(Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9)))).toEqual([
      0xff, 0xd8, 7, 0xff, 0x00, 0xff, 0xd9,
    ]);
  });

  it('drops what follows the end of image, such as the byte that pads an item', () => {
    expect(Array.from(withFillBeforeEnd(Uint8Array.of(0xff, 0xd8, 7, 0xff, 0xd9, 0)))).toEqual([
      0xff, 0xd8, 7, 0xff, 0x00, 0xff, 0xd9,
    ]);
  });

  it('throws when there is no end of image', () => {
    expect(() => withFillBeforeEnd(Uint8Array.of(0xff, 0xd8, 7))).toThrow(/no end of image/);
  });
});
