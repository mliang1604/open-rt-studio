/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A minimal DICOM Part 10 writer (Explicit VR Little Endian) for building
// synthetic test files in memory. It writes only what the generators in this
// package need; it is not a general DICOM writer and must never be used to
// produce files for anything but tests.

const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';

/** VRs whose explicit-VR header has two reserved bytes and a 32-bit length. */
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

/** One encoded data element, kept with its tag so a data set can be sorted. */
export interface DataElement {
  readonly group: number;
  readonly element: number;
  readonly bytes: Uint8Array;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function padEven(bytes: Uint8Array, padByte: number): Uint8Array {
  return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(padByte)]);
}

/** A text value, space-padded to even length. */
export const text = (s: string): Uint8Array => padEven(ascii(s), 0x20);

/** A UID value, null-padded to even length. */
export const uid = (s: string): Uint8Array => padEven(ascii(s), 0x00);

/** A multi-valued decimal or integer string (DS, IS), backslash-separated. */
export const numbers = (values: readonly number[]): Uint8Array => text(values.join('\\'));

export function u16le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Encode one Explicit VR Little Endian data element. */
export function el(group: number, element: number, vr: string, value: Uint8Array): DataElement {
  const long = LONG_VRS.has(vr);
  const header = new Uint8Array(long ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (long) view.setUint32(8, value.length, true);
  else view.setUint16(6, value.length, true);
  return { group, element, bytes: concat([header, value]) };
}

/** Elements in ascending tag order, as the standard requires, as one byte run. */
export function dataSet(elements: readonly DataElement[]): Uint8Array {
  const sorted = [...elements].sort((a, b) => a.group - b.group || a.element - b.element);
  return concat(sorted.map((e) => e.bytes));
}

/** An SQ element whose items are data sets with explicit (defined) lengths. */
export function sequence(
  group: number,
  element: number,
  items: readonly (readonly DataElement[])[],
): DataElement {
  const body = concat(
    items.map((item) => {
      const bytes = dataSet(item);
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint16(0, 0xfffe, true); // Item tag (FFFE,E000)
      view.setUint16(2, 0xe000, true);
      view.setUint32(4, bytes.length, true);
      return concat([header, bytes]);
    }),
  );
  return el(group, element, 'SQ', body);
}

/** A 16-bit unsigned PixelData element from raw samples. */
export function pixelData16(samples: ArrayLike<number>): DataElement {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setUint16(i * 2, samples[i], true);
  return el(0x7fe0, 0x0010, 'OW', out);
}

/**
 * An encapsulated PixelData element: an empty Basic Offset Table, then one
 * item per frame, then the sequence delimiter. This is how compressed pixel
 * data is stored. The frames are written as given; nothing here compresses.
 */
export function encapsulatedPixelData(frames: readonly Uint8Array[]): DataElement {
  const item = (body: Uint8Array): Uint8Array => {
    const padded = padEven(body, 0x00);
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint16(0, 0xfffe, true); // Item tag (FFFE,E000)
    view.setUint16(2, 0xe000, true);
    view.setUint32(4, padded.length, true);
    return concat([header, padded]);
  };
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0x7fe0, true);
  view.setUint16(2, 0x0010, true);
  header[4] = 'O'.charCodeAt(0);
  header[5] = 'B'.charCodeAt(0);
  view.setUint32(8, 0xffffffff, true); // undefined length marks encapsulation
  const delimiter = new Uint8Array(8);
  const end = new DataView(delimiter.buffer);
  end.setUint16(0, 0xfffe, true); // Sequence Delimitation Item (FFFE,E0DD)
  end.setUint16(2, 0xe0dd, true);
  const bytes = concat([header, item(new Uint8Array(0)), ...frames.map(item), delimiter]);
  return { group: 0x7fe0, element: 0x0010, bytes };
}

/**
 * A complete Part 10 file: 128-byte preamble, `DICM`, the file meta group and
 * the data set. SOP Class and Instance UID are written to both, as real files
 * have them. The data set is always written as Explicit VR Little Endian;
 * `transferSyntaxUid` only changes what the file declares, for files whose
 * pixel data is encapsulated.
 */
export function part10(
  sopClassUid: string,
  sopInstanceUid: string,
  elements: readonly DataElement[],
  transferSyntaxUid: string = EXPLICIT_VR_LE,
): Uint8Array {
  const meta = dataSet([
    el(0x0002, 0x0001, 'OB', Uint8Array.of(0, 1)), // FileMetaInformationVersion
    el(0x0002, 0x0002, 'UI', uid(sopClassUid)), // MediaStorageSOPClassUID
    el(0x0002, 0x0003, 'UI', uid(sopInstanceUid)), // MediaStorageSOPInstanceUID
    el(0x0002, 0x0010, 'UI', uid(transferSyntaxUid)), // TransferSyntaxUID
  ]);
  const groupLength = el(0x0002, 0x0000, 'UL', u32le(meta.length));
  const body = dataSet([
    el(0x0008, 0x0016, 'UI', uid(sopClassUid)), // SOPClassUID
    el(0x0008, 0x0018, 'UI', uid(sopInstanceUid)), // SOPInstanceUID
    ...elements,
  ]);
  return concat([new Uint8Array(128), ascii('DICM'), groupLength.bytes, meta, body]);
}
