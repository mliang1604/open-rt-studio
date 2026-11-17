/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { jpegFrameHeader, jpegScanHeader } from './jpeg-header.js';

const SOI = [0xff, 0xd8];
/** An APP0 segment with `n` bytes of payload. */
const app0 = (n: number) => [0xff, 0xe0, (n + 2) >> 8, (n + 2) & 0xff, ...new Array(n).fill(0x4a)];
/** A frame header segment for one component. */
const sof = (marker: number, precision: number, rows: number, columns: number) => [
  0xff,
  marker,
  0x00,
  0x0b,
  precision,
  rows >> 8,
  rows & 0xff,
  columns >> 8,
  columns & 0xff,
  0x01,
  0x01,
  0x11,
  0x00,
];

describe('jpegFrameHeader', () => {
  it('reads precision, size and component count from a baseline frame', () => {
    const bytes = Uint8Array.from([...SOI, ...sof(0xc0, 8, 512, 300)]);
    expect(jpegFrameHeader(bytes)).toEqual({
      marker: 0xc0,
      precision: 8,
      rows: 512,
      columns: 300,
      components: 1,
    });
  });

  it('finds the frame header after other segments', () => {
    const bytes = Uint8Array.from([...SOI, ...app0(14), ...app0(300), ...sof(0xc1, 12, 64, 64)]);
    expect(jpegFrameHeader(bytes)?.precision).toBe(12);
    expect(jpegFrameHeader(bytes)?.marker).toBe(0xc1);
  });

  it('reads a lossless frame of 16 bits', () => {
    const bytes = Uint8Array.from([...SOI, ...sof(0xc3, 16, 2, 4)]);
    expect(jpegFrameHeader(bytes)).toMatchObject({ marker: 0xc3, precision: 16 });
  });

  it('does not take a Huffman table segment for a frame header', () => {
    // DHT is 0xC4, inside the SOF range.
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
    const bytes = Uint8Array.from([...SOI, ...dht, ...sof(0xc0, 8, 2, 2)]);
    expect(jpegFrameHeader(bytes)?.marker).toBe(0xc0);
  });

  it('skips fill bytes before a marker', () => {
    const bytes = Uint8Array.from([...SOI, 0xff, 0xff, ...sof(0xc0, 8, 2, 2)]);
    expect(jpegFrameHeader(bytes)?.rows).toBe(2);
  });

  it('returns null for bytes that are not a JPEG stream', () => {
    expect(jpegFrameHeader(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(jpegFrameHeader(new Uint8Array(0))).toBeNull();
    // A JPEG-LS stream starts with SOI too, but its frame marker is 0xF7.
    const jls = Uint8Array.from([...SOI, 0xff, 0xf7, 0x00, 0x0b, 8, 0, 2, 0, 4, 1, 1, 0x11, 0]);
    expect(jpegFrameHeader(jls)).toBeNull();
  });

  it('returns null when the stream ends, or a scan starts, before a frame header', () => {
    expect(jpegFrameHeader(Uint8Array.from([...SOI, ...app0(4)]))).toBeNull();
    expect(
      jpegFrameHeader(Uint8Array.from([...SOI, ...sof(0xc0, 8, 2, 2)].slice(0, 9))),
    ).toBeNull();
    expect(jpegFrameHeader(Uint8Array.from([...SOI, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });
});

describe('jpegScanHeader', () => {
  /** A scan header for one component: predictor (Ss), then Ah and Al. */
  const sos = (predictor: number, al: number) => [0xff, 0xda, 0, 8, 1, 1, 0, predictor, 0, al];
  const dri = (interval: number) => [0xff, 0xdd, 0, 4, interval >> 8, interval & 0xff];

  it('reads the predictor and the point transform of the first scan', () => {
    const bytes = Uint8Array.from([...SOI, ...sof(0xc3, 16, 2, 4), ...sos(4, 0x02), 0x55]);
    expect(jpegScanHeader(bytes)).toEqual({ restartInterval: 0, predictor: 4, pointTransform: 2 });
  });

  it('reads a restart interval defined before the scan', () => {
    const bytes = Uint8Array.from([...SOI, ...sof(0xc3, 16, 2, 4), ...dri(513), ...sos(1, 0)]);
    expect(jpegScanHeader(bytes)).toEqual({
      restartInterval: 513,
      predictor: 1,
      pointTransform: 0,
    });
  });

  it('reads the scan of three components', () => {
    const scan = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0, 3, 0, 6, 0, 0];
    expect(jpegScanHeader(Uint8Array.from([...SOI, ...app0(5), ...scan]))?.predictor).toBe(6);
  });

  it('is null without a scan, or when the scan header is cut short', () => {
    expect(
      jpegScanHeader(Uint8Array.from([...SOI, ...sof(0xc3, 16, 2, 4), 0xff, 0xd9])),
    ).toBeNull();
    expect(jpegScanHeader(Uint8Array.from([...SOI, ...sos(1, 0).slice(0, 6)]))).toBeNull();
    expect(jpegScanHeader(Uint8Array.of(1, 2, 3, 4, 5, 6))).toBeNull();
    expect(jpegScanHeader(new Uint8Array(0))).toBeNull();
  });
});
