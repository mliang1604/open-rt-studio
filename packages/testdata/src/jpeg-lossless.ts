/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A JPEG Lossless encoder for greyscale and three-component images, written from ITU-T T.81
// (Annex H, with the Huffman coding of Annexes C and F). It exists so the
// tests have JPEG Lossless files without a file in the repository, and so the
// decoder the application uses is tried on streams it did not make: the
// decoder is a third-party package, and nothing here comes from it.
//
// It writes what DICOM's two JPEG Lossless transfer syntaxes hold: one frame
// (SOF3), one scan, Huffman coding, any of the seven predictors, 2 to 16 bits
// a sample, one component or three interleaved ones, and optional restart
// markers. It does not do a point transform, subsampling or arithmetic coding.

/** The seven predictors of T.81 Table H.1. DICOM's "first-order" syntax is 1. */
export type JpegLosslessPredictor = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** How {@link encodeJpegLossless} is to write a frame. */
export interface JpegLosslessOptions {
  /** Bits a sample, 2 to 16. Default: 8 for bytes, 16 for 16-bit samples. */
  readonly precision?: number;
  /** The predictor, 1 to 7. Default 1: the sample to the left. */
  readonly predictor?: JpegLosslessPredictor;
  /**
   * Put a restart marker after every so many lines, which starts the
   * prediction afresh there. Default 0: none.
   */
  readonly restartLines?: number;
  /**
   * Components a pixel: 1, or 3 with the samples of a pixel side by side
   * (R, G, B, R, G, B, …), each component predicted from its own. Default 1.
   */
  readonly components?: 1 | 3;
}

/**
 * How long the code of each difference category is, categories 0 to 16. One
 * code of two bits, five of three, then one of each length to fourteen: the
 * shape of the tables encoders ship, and none is all ones, as T.81 requires.
 */
const CODE_LENGTHS: readonly number[] = [2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** The codes T.81 Annex C gives those lengths: in order, counting up. */
function huffmanCodes(): number[] {
  const codes: number[] = [];
  let code = 0;
  let length = CODE_LENGTHS[0];
  for (const next of CODE_LENGTHS) {
    code <<= next - length;
    length = next;
    codes.push(code++);
  }
  return codes;
}

/** Bits into bytes, most significant first, with a zero after every 0xFF. */
class BitWriter {
  private readonly bytes: number[] = [];
  private held = 0;
  private count = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.held = (this.held << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }

  /** Fill the last byte with ones, as T.81 F.1.2.3 says. */
  pad(): void {
    while (this.count !== 0) this.write(1, 1);
  }

  /** A marker: never stuffed, and only on a byte boundary. */
  marker(low: number): void {
    this.pad();
    this.bytes.push(0xff, low);
  }

  raw(values: readonly number[]): void {
    this.bytes.push(...values);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  private flushByte(): void {
    this.bytes.push(this.held);
    if (this.held === 0xff) this.bytes.push(0);
    this.held = 0;
    this.count = 0;
  }
}

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];

/**
 * What a sample is predicted to be from its neighbours: `a` to the left, `b`
 * above, `c` above and to the left (T.81 Table H.1). The halves are
 * arithmetic shifts.
 */
function predict(predictor: JpegLosslessPredictor, a: number, b: number, c: number): number {
  switch (predictor) {
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return c;
    case 4:
      return a + b - c;
    case 5:
      return a + ((b - c) >> 1);
    case 6:
      return b + ((a - c) >> 1);
    case 7:
      return (a + b) >> 1;
    default: {
      const exhaustive: never = predictor;
      throw new Error(`No such predictor: ${String(exhaustive)}`);
    }
  }
}

/**
 * Encode an image as a JPEG Lossless stream (SOF3, Huffman). `samples` holds
 * `rows` lines of `columns` pixels, each sample below 2^precision. The stream
 * decodes to exactly those samples.
 */
export function encodeJpegLossless(
  samples: Uint8Array | Uint16Array,
  columns: number,
  rows: number,
  options: JpegLosslessOptions = {},
): Uint8Array {
  const precision = options.precision ?? (samples instanceof Uint8Array ? 8 : 16);
  const predictor = options.predictor ?? 1;
  const restartLines = options.restartLines ?? 0;
  const n = options.components ?? 1;
  if (precision < 2 || precision > 16) throw new Error('JPEG Lossless holds 2 to 16 bits a sample');
  if (samples.length !== rows * columns * n) throw new Error('The samples do not fill the image');
  if (columns < 1 || rows < 1 || columns > 0xffff || rows > 0xffff) {
    throw new Error('A JPEG frame is 1 to 65535 samples each way');
  }

  const out = new BitWriter();
  out.marker(0xd8); // SOI
  out.marker(0xc3); // SOF3: lossless, Huffman
  const ids = Array.from({ length: n }, (_, c) => c + 1);
  out.raw([...u16(8 + 3 * n), precision, ...u16(rows), ...u16(columns), n]);
  out.raw(ids.flatMap((id) => [id, 0x11, 0])); // each: one sample a pixel, no table
  out.marker(0xc4); // DHT: table 0, class 0
  const counts = new Array<number>(16).fill(0);
  for (const length of CODE_LENGTHS) counts[length - 1]++;
  out.raw([...u16(2 + 1 + 16 + CODE_LENGTHS.length), 0x00, ...counts, ...CODE_LENGTHS.keys()]);
  if (restartLines > 0) {
    out.marker(0xdd); // DRI, counted in pixels
    out.raw([...u16(4), ...u16(restartLines * columns)]);
  }
  out.marker(0xda); // SOS: every component on table 0, the predictor, no point transform
  out.raw([...u16(6 + 2 * n), n, ...ids.flatMap((id) => [id, 0x00]), predictor, 0, 0x00]);

  const codes = huffmanCodes();
  const start = 1 << (precision - 1);
  let restarts = 0;
  for (let y = 0; y < rows; y++) {
    // The line after a restart is predicted as the first line of the image is.
    const first = restartLines > 0 ? y % restartLines === 0 : y === 0;
    if (first && y > 0) out.marker(0xd0 + (restarts++ & 7)); // RSTm
    for (let at = y * columns * n, x = 0; x < columns; x++) {
      for (let c = 0; c < n; c++, at++) {
        const left = at - n;
        const above = at - columns * n;
        let predicted: number;
        if (first) predicted = x === 0 ? start : samples[left];
        else if (x === 0) predicted = samples[above];
        else predicted = predict(predictor, samples[left], samples[above], samples[above - n]);

        // The difference, modulo 2^16, as a number from -32767 to 32768.
        let difference = (samples[at] - predicted) & 0xffff;
        if (difference > 32768) difference -= 65536;
        let category = 0;
        for (let size = Math.abs(difference); size > 0; size >>= 1) category++;
        out.write(codes[category], CODE_LENGTHS[category]);
        // Category 16 is 32768 alone and has no bits of its own.
        if (category > 0 && category < 16) {
          const bits = difference >= 0 ? difference : difference - 1;
          out.write(bits & ((1 << category) - 1), category);
        }
      }
    }
  }
  out.marker(0xd9); // EOI
  return out.finish();
}
