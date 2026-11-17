/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment node

import { parseFile, parseFileAsync, UnsupportedDicomError } from '@open-rt-studio/dicom';
import { el, encapsulatedPixelData, part10, text, u16le } from './dicom-writer.js';
import {
  JPEG_LOSSLESS_ANY_SYNTAX,
  JPEG_LOSSLESS_SYNTAX,
  syntheticCtSeries,
  syntheticCtValue,
} from './image-series.js';
import {
  encodeJpegLossless,
  type JpegLosslessOptions,
  type JpegLosslessPredictor,
} from './jpeg-lossless.js';

const PREDICTORS: readonly JpegLosslessPredictor[] = [1, 2, 3, 4, 5, 6, 7];

/** What the image part of a file says of its samples. */
interface Layout {
  readonly columns: number;
  readonly rows: number;
  readonly bitsAllocated: 8 | 16;
  readonly bitsStored: number;
  readonly signed?: boolean;
  readonly photometric?: 'MONOCHROME2' | 'RGB' | 'YBR_FULL';
}

/** A secondary-capture-like file around a PixelData element, native or encapsulated. */
function file(layout: Layout, pixelData: ReturnType<typeof el>, syntax?: string): ArrayBuffer {
  const photometric = layout.photometric ?? 'MONOCHROME2';
  const colour = photometric !== 'MONOCHROME2';
  const bytes = part10(
    '1.2.840.10008.5.1.4.1.1.7',
    '1.2.826.0.1.3680043.10.1561.999.1',
    [
      el(0x0008, 0x0060, 'CS', text('OT')), // Modality
      el(0x0028, 0x0002, 'US', u16le(colour ? 3 : 1)), // SamplesPerPixel
      el(0x0028, 0x0004, 'CS', text(photometric)), // PhotometricInterpretation
      ...(colour ? [el(0x0028, 0x0006, 'US', u16le(0))] : []), // PlanarConfiguration
      el(0x0028, 0x0010, 'US', u16le(layout.rows)), // Rows
      el(0x0028, 0x0011, 'US', u16le(layout.columns)), // Columns
      el(0x0028, 0x0100, 'US', u16le(layout.bitsAllocated)), // BitsAllocated
      el(0x0028, 0x0101, 'US', u16le(layout.bitsStored)), // BitsStored
      el(0x0028, 0x0102, 'US', u16le(layout.bitsStored - 1)), // HighBit
      el(0x0028, 0x0103, 'US', u16le(layout.signed ? 1 : 0)), // PixelRepresentation
      pixelData,
    ],
    syntax,
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
}

/** The samples as an uncompressed PixelData element. */
function native(samples: Uint8Array | Uint16Array): ReturnType<typeof el> {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const even = bytes.length % 2 === 0 ? bytes : Uint8Array.from([...bytes, 0]);
  return el(0x7fe0, 0x0010, samples instanceof Uint8Array ? 'OB' : 'OW', even);
}

/** The pixels the loader gives for the samples stored uncompressed. */
function expected(layout: Layout, samples: Uint8Array | Uint16Array): Float32Array {
  return parseFile('native.dcm', file(layout, native(samples)))[0].pixels;
}

/** The pixels the loader gives for the same samples as one JPEG Lossless frame. */
async function decoded(
  layout: Layout,
  samples: Uint8Array | Uint16Array,
  options: JpegLosslessOptions,
): Promise<Float32Array> {
  const frame = encodeJpegLossless(samples, layout.columns, layout.rows, options);
  const syntax = options.predictor === 1 ? JPEG_LOSSLESS_SYNTAX : JPEG_LOSSLESS_ANY_SYNTAX;
  const slices = await parseFileAsync(
    'lossless.dcm',
    file(layout, encapsulatedPixelData([frame]), syntax),
  );
  expect(slices).toHaveLength(1);
  return slices[0].pixels;
}

/** Images that are hard in different ways. Each gives sample `i` of an image. */
const IMAGES: Readonly<Record<string, (i: number) => number>> = {
  ramp: (i) => i * 37,
  noise: (i) => Math.imul(i + 1, 2654435761) >>> 7,
  // Neighbours as far apart as samples can be: the differences wrap round.
  extremes: (i) => [0, 65535, 32768, 32767, 1, 65534][i % 6],
  // Differences of 0 throughout: the shortest codes, and streams that end on
  // a byte boundary for some sizes.
  flat: () => 1234,
};

const SIZES: readonly (readonly [columns: number, rows: number])[] = [
  [37, 23],
  [64, 64],
  [1, 1],
  [1, 9],
  [9, 1],
  [5, 3],
];

function fill<T extends Uint8Array | Uint16Array>(samples: T, image: string, bits: number): T {
  const mask = (1 << bits) - 1;
  for (let i = 0; i < samples.length; i++) samples[i] = IMAGES[image](i) & mask;
  return samples;
}

describe('encodeJpegLossless', () => {
  it('writes the stream ITU-T T.81 gives for an image worked out by hand', () => {
    // 128 129: the differences are 0 (from 2^7) and +1 (from the left). In
    // the table here that is `00`, then `010` and a `1`, then two fill bits.
    const stream = encodeJpegLossless(Uint8Array.of(128, 129), 2, 1);
    expect(Array.from(stream)).toEqual([
      ...[0xff, 0xd8], // SOI
      ...[0xff, 0xc3, 0, 11, 8, 0, 1, 0, 2, 1, 1, 0x11, 0], // SOF3: 8 bits, 1 × 2, one component
      ...[0xff, 0xc4, 0, 36, 0x00], // DHT
      ...[0, 1, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      ...[0xff, 0xda, 0, 8, 1, 1, 0x00, 1, 0, 0x00], // SOS: predictor 1
      0b00010111,
      ...[0xff, 0xd9], // EOI
    ]);
  });

  it('follows a byte of ones with a zero, and marks restarts', () => {
    // 33023 after 32768 is a difference of +255: category 8, whose code is
    // `111110`, then the eight bits `11111111`. With the `00` of the first
    // sample that is 0x3E 0xFF exactly, and the 0xFF is stuffed.
    const stream = encodeJpegLossless(Uint16Array.of(32768, 33023), 2, 1);
    expect(Array.from(stream.subarray(stream.length - 5))).toEqual([0x3e, 0xff, 0x00, 0xff, 0xd9]);

    const restarted = encodeJpegLossless(Uint8Array.of(128, 128, 128), 1, 3, { restartLines: 1 });
    // Each line is `00` and six fill bits, with RST0 and RST1 between them.
    expect(Array.from(restarted.subarray(restarted.length - 9))).toEqual([
      ...[0x3f, 0xff, 0xd0],
      ...[0x3f, 0xff, 0xd1],
      ...[0x3f, 0xff, 0xd9],
    ]);
    // DRI before the scan: an interval of one line, which is one sample.
    const dri = restarted.indexOf(0xdd);
    expect(Array.from(restarted.subarray(dri - 1, dri + 5))).toEqual([0xff, 0xdd, 0, 4, 0, 1]);
  });

  it('refuses what it cannot write', () => {
    expect(() => encodeJpegLossless(new Uint8Array(3), 2, 2)).toThrow(/do not fill/);
    expect(() => encodeJpegLossless(new Uint8Array(4), 2, 2, { precision: 1 })).toThrow(/2 to 16/);
  });
});

describe('JPEG Lossless files, read by the DICOM package', () => {
  // The decoder is a third-party package; the encoder is this package's own,
  // written from the standard. Every case is the same image stored twice, once
  // uncompressed, and the two must read as the same pixels.
  it('reads 16-bit samples exactly, for every predictor it supports', async () => {
    const tried: string[] = [];
    for (const [columns, rows] of SIZES) {
      for (const image of Object.keys(IMAGES)) {
        const layout: Layout = { columns, rows, bitsAllocated: 16, bitsStored: 16 };
        const samples = fill(new Uint16Array(columns * rows), image, 16);
        const want = expected(layout, samples);
        for (const predictor of PREDICTORS.filter((p) => p !== 7)) {
          const got = await decoded(layout, samples, { predictor });
          expect(got, `${columns}x${rows} ${image}, predictor ${predictor}`).toEqual(want);
          tried.push(image);
        }
      }
    }
    expect(tried).toHaveLength(SIZES.length * 4 * 6);
  });

  it('reads signed 16-bit samples exactly', async () => {
    for (const image of Object.keys(IMAGES)) {
      const layout: Layout = {
        columns: 37,
        rows: 23,
        bitsAllocated: 16,
        bitsStored: 16,
        signed: true,
      };
      const samples = fill(new Uint16Array(37 * 23), image, 16);
      const want = expected(layout, samples);
      // Stored 65535 is -1 here: the uncompressed reading has negatives.
      if (image === 'extremes') expect(Math.min(...want)).toBe(-32768);
      for (const predictor of PREDICTORS.filter((p) => p !== 7)) {
        expect(await decoded(layout, samples, { predictor }), image).toEqual(want);
      }
    }
  });

  it('reads 12 bits in 16, 8 bits in 8 and 8 bits in 16 exactly, for all seven predictors', async () => {
    for (const [columns, rows] of SIZES) {
      for (const image of Object.keys(IMAGES)) {
        const twelve: Layout = { columns, rows, bitsAllocated: 16, bitsStored: 12 };
        const words = fill(new Uint16Array(columns * rows), image, 12);
        const eight: Layout = { columns, rows, bitsAllocated: 8, bitsStored: 8 };
        const bytes = fill(new Uint8Array(columns * rows), image, 8);
        const wide: Layout = { columns, rows, bitsAllocated: 16, bitsStored: 8 };
        const wideWords = Uint16Array.from(bytes);
        for (const predictor of PREDICTORS) {
          const label = `${columns}x${rows} ${image}, predictor ${predictor}`;
          expect(await decoded(twelve, words, { predictor, precision: 12 }), label).toEqual(
            expected(twelve, words),
          );
          expect(await decoded(eight, bytes, { predictor }), label).toEqual(expected(eight, bytes));
          // An 8-bit stream in a file that allocates 16 bits a sample.
          expect(await decoded(wide, bytes, { predictor }), label).toEqual(
            expected(wide, wideWords),
          );
        }
      }
    }
  });

  it('reads colour exactly, RGB and YBR_FULL', async () => {
    for (const photometric of ['RGB', 'YBR_FULL'] as const) {
      for (const [columns, rows] of SIZES) {
        const layout: Layout = { columns, rows, bitsAllocated: 8, bitsStored: 8, photometric };
        for (const image of ['ramp', 'noise', 'flat']) {
          const samples = fill(new Uint8Array(columns * rows * 3), image, 8);
          const want = expected(layout, samples);
          for (const predictor of PREDICTORS) {
            const got = await decoded(layout, samples, { predictor, components: 3 });
            expect(got, `${photometric} ${columns}x${rows} ${image} ${predictor}`).toEqual(want);
          }
        }
      }
    }
  });

  it('keeps the last sample whatever bit the stream ends on', async () => {
    // A flat line of n samples is 2n bits and a few for the first: every
    // fourth length ends on a byte boundary, where the decoder alone drops
    // the last sample.
    for (let columns = 1; columns <= 24; columns++) {
      const layout: Layout = { columns, rows: 1, bitsAllocated: 16, bitsStored: 16 };
      const samples = new Uint16Array(columns).fill(32768);
      expect(await decoded(layout, samples, { predictor: 1 }), `${columns}`).toEqual(
        expected(layout, samples),
      );
    }
  });

  it('refuses by name the streams its decoder gets wrong', async () => {
    const layout: Layout = { columns: 8, rows: 8, bitsAllocated: 16, bitsStored: 16 };
    const samples = fill(new Uint16Array(64), 'noise', 16);
    const reason = async (options: JpegLosslessOptions): Promise<string> => {
      const error: unknown = await decoded(layout, samples, options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedDicomError);
      return (error as UnsupportedDicomError).reason;
    };
    for (const predictor of PREDICTORS) {
      expect(await reason({ predictor, restartLines: 2 })).toBe(
        'JPEG Lossless with restart markers is not supported',
      );
    }
    expect(await reason({ predictor: 7 })).toBe(
      'JPEG Lossless with predictor 7 at 16 bits is not supported',
    );
  });
});

describe('a synthetic CT series stored as JPEG Lossless', () => {
  it('reads as the values of syntheticCtValue, like the uncompressed series', async () => {
    const [count, size] = [5, 32];
    for (const predictor of [1, 4] as const) {
      const files = syntheticCtSeries(count, size, { encoding: { jpegLossless: predictor } });
      const plain = syntheticCtSeries(count, size);
      expect(files).toHaveLength(count);
      for (const [z, f] of files.entries()) {
        const buffer = f.bytes.buffer.slice(
          f.bytes.byteOffset,
          f.bytes.byteOffset + f.bytes.length,
        );
        const [slice] = await parseFileAsync(f.name, buffer as ArrayBuffer);
        const p = plain[z].bytes;
        const [same] = parseFile(
          plain[z].name,
          p.buffer.slice(p.byteOffset, p.byteOffset + p.length) as ArrayBuffer,
        );
        expect(slice.pixels).toEqual(same.pixels);
        expect(slice.position).toEqual(same.position);
        // Rescaled: the stored value and the intercept the generator writes.
        expect(slice.pixels[7] - slice.rescaleIntercept).toBe(syntheticCtValue(7, z, size));
        expect(f.bytes.length).toBeLessThan(plain[z].bytes.length);
      }
    }
  });

  it('declares the first-order syntax for predictor 1 and the general one otherwise', () => {
    const syntaxOf = (bytes: Uint8Array): string => {
      const head = String.fromCharCode(...bytes.subarray(0, 400));
      return /1\.2\.840\.10008\.1\.2\.4\.\d+/.exec(head)?.[0] ?? '';
    };
    const one = syntheticCtSeries(1, 8, { encoding: { jpegLossless: 1 } })[0];
    const four = syntheticCtSeries(1, 8, { encoding: { jpegLossless: 4 } })[0];
    expect(syntaxOf(one.bytes)).toBe(JPEG_LOSSLESS_SYNTAX);
    expect(syntaxOf(four.bytes)).toBe(JPEG_LOSSLESS_ANY_SYNTAX);
  });
});
