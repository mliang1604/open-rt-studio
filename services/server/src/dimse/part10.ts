/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An object arrives by C-STORE as the bytes of its data set and nothing
// else. What the PACS keeps is a Part 10 file: the same bytes, untouched,
// behind a preamble, `DICM` and a File Meta Information group that says what
// they are and who wrote the file.

import { SERVER_VERSION } from '../version.js';

/**
 * This server as the writer of a file's meta information. The UID is under
 * the root for UUID-derived UIDs (2.25) and names this implementation, not a
 * version of it; the version name is the 16 characters at most that go with it.
 */
export const IMPLEMENTATION_CLASS_UID = '2.25.217255945869031963736910959332504773952';
export const IMPLEMENTATION_VERSION_NAME =
  `ORS_${SERVER_VERSION.replace(/[^0-9A-Za-z]/g, '_')}`.slice(0, 16);

/** What a C-STORE says of the object it carries. */
export interface ReceivedDataSet {
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  /** The transfer syntax the association agreed for it. */
  readonly transferSyntax: string;
  /** The AE title that sent it. */
  readonly sourceAeTitle: string;
  readonly dataSet: Uint8Array;
}

/** One element of the meta group, which is always Explicit VR Little Endian. */
function element(tag: number, vr: 'UI' | 'SH' | 'AE', value: string): Buffer {
  const pad = vr === 'UI' ? '\0' : ' ';
  const text = Buffer.from(value.length % 2 ? value + pad : value, 'ascii');
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0002, 0);
  head.writeUInt16LE(tag, 2);
  head.write(vr, 4, 'ascii');
  head.writeUInt16LE(text.length, 6);
  return Buffer.concat([head, text]);
}

/** The preamble, `DICM` and the File Meta Information for a received object. */
export function fileMeta(object: Omit<ReceivedDataSet, 'dataSet'>): Buffer {
  // (0002,0001) File Meta Information Version: OB, two reserved bytes, a 4-byte length.
  const version = Buffer.from([0x02, 0, 0x01, 0, 0x4f, 0x42, 0, 0, 2, 0, 0, 0, 0, 1]);
  const group = Buffer.concat([
    version,
    element(0x0002, 'UI', object.sopClassUid), // Media Storage SOP Class UID
    element(0x0003, 'UI', object.sopInstanceUid), // Media Storage SOP Instance UID
    element(0x0010, 'UI', object.transferSyntax), // Transfer Syntax UID
    element(0x0012, 'UI', IMPLEMENTATION_CLASS_UID),
    element(0x0013, 'SH', IMPLEMENTATION_VERSION_NAME),
    element(0x0016, 'AE', object.sourceAeTitle), // Source Application Entity Title
  ]);
  // (0002,0000) File Meta Information Group Length: UL, the bytes that follow it.
  const length = Buffer.from([0x02, 0, 0, 0, 0x55, 0x4c, 4, 0, 0, 0, 0, 0]);
  length.writeUInt32LE(group.length, 8);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'ascii'), length, group]);
}

/** A Part 10 file of a received object: the meta information, then its bytes as they came. */
export function part10(object: ReceivedDataSet): Uint8Array {
  return Buffer.concat([fileMeta(object), object.dataSet]);
}

/**
 * The data set of a Part 10 file: what follows the preamble, `DICM` and the
 * meta group. Null for bytes that do not begin as a Part 10 file does.
 */
export function dataSetOf(file: Uint8Array): Uint8Array | null {
  if (file.length < 144 || Buffer.from(file.subarray(128, 132)).toString('ascii') !== 'DICM') {
    return null;
  }
  const view = new DataView(file.buffer, file.byteOffset, file.length);
  // (0002,0000) comes first: its tag, `UL`, a length of 4, then the group's length.
  if (view.getUint16(132, true) !== 0x0002 || view.getUint16(134, true) !== 0x0000) return null;
  const start = 144 + view.getUint32(140, true);
  return start <= file.length ? file.subarray(start) : null;
}
