/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readInstanceHeader } from '@open-rt-studio/dicom';
import { syntheticCtSeries, syntheticRtCourse } from '@open-rt-studio/testdata';

import { SERVER_VERSION } from '../version.js';
import {
  dataSetOf,
  fileMeta,
  IMPLEMENTATION_CLASS_UID,
  IMPLEMENTATION_VERSION_NAME,
  part10,
} from './part10.js';
import { EXPLICIT_VR_LE } from './sop-classes.js';
import { isUid } from '../uid.js';

const OBJECT = {
  sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
  sopInstanceUid: '1.2.826.0.1.3680043.999.12345',
  transferSyntax: EXPLICIT_VR_LE,
  sourceAeTitle: 'PEER',
};

/** The elements of a meta group, by element number, as text. */
function metaElements(meta: Uint8Array): Map<number, string> {
  const view = new DataView(meta.buffer, meta.byteOffset, meta.length);
  const found = new Map<number, string>();
  let at = 132;
  while (at < meta.length) {
    const element = view.getUint16(at + 2, true);
    const vr = String.fromCharCode(meta[at + 4], meta[at + 5]);
    const long = vr === 'OB';
    const length = long ? view.getUint32(at + 8, true) : view.getUint16(at + 6, true);
    const start = at + (long ? 12 : 8);
    found.set(element, Buffer.from(meta.subarray(start, start + length)).toString('latin1'));
    at = start + length;
  }
  return found;
}

describe('fileMeta', () => {
  it('is a preamble, DICM and a meta group whose length is right', () => {
    const meta = fileMeta(OBJECT);
    expect(meta.subarray(0, 128).every((byte) => byte === 0)).toBe(true);
    expect(meta.subarray(128, 132).toString('ascii')).toBe('DICM');
    expect(meta.readUInt32LE(140)).toBe(meta.length - 144);
    expect(meta.length % 2).toBe(0);
  });

  it('says what the object is, in which transfer syntax, and who wrote and sent it', () => {
    const elements = metaElements(fileMeta(OBJECT));
    expect([...elements.keys()]).toEqual([
      0x0000, 0x0001, 0x0002, 0x0003, 0x0010, 0x0012, 0x0013, 0x0016,
    ]);
    expect(elements.get(0x0001)).toBe('\x00\x01');
    expect(elements.get(0x0002)).toBe(`${OBJECT.sopClassUid}\0`);
    // An odd length is padded: a UID with a null, text with a space.
    expect(elements.get(0x0003)).toBe(`${OBJECT.sopInstanceUid}\0`);
    expect(elements.get(0x0010)).toBe(`${EXPLICIT_VR_LE}\0`);
    expect(elements.get(0x0012)?.replace(/\0$/, '')).toBe(IMPLEMENTATION_CLASS_UID);
    expect(elements.get(0x0013)?.trimEnd()).toBe(IMPLEMENTATION_VERSION_NAME);
    expect(elements.get(0x0016)).toBe('PEER');
  });

  it('names an implementation with a UID and a version name the standard allows', () => {
    expect(isUid(IMPLEMENTATION_CLASS_UID)).toBe(true);
    expect(IMPLEMENTATION_VERSION_NAME.length).toBeLessThanOrEqual(16);
    expect(IMPLEMENTATION_VERSION_NAME).toBe(`ORS_${SERVER_VERSION.replaceAll('.', '_')}`);
  });
});

describe('part10 and dataSetOf', () => {
  it('put a header in front of a data set and take it off again, the bytes untouched', () => {
    for (const file of syntheticRtCourse()) {
      const dataSet = dataSetOf(file.bytes)!;
      const header = readInstanceHeader(file.bytes);
      if (!header.ok) throw new Error('the generator wrote something unreadable');
      const written = part10({
        ...OBJECT,
        sopClassUid: header.header.sopClassUid,
        sopInstanceUid: header.header.sopInstanceUid,
        dataSet,
      });
      expect(Buffer.from(dataSetOf(written)!).equals(Buffer.from(dataSet)), file.name).toBe(true);
      // And the result reads as the object it is.
      const read = readInstanceHeader(written);
      expect(read.ok && read.header.sopInstanceUid, file.name).toBe(header.header.sopInstanceUid);
      expect(read.ok && read.header.transferSyntaxUid, file.name).toBe(EXPLICIT_VR_LE);
    }
  });

  it('dataSetOf is null for what is not a Part 10 file', () => {
    expect(dataSetOf(new Uint8Array(10))).toBeNull();
    expect(dataSetOf(new Uint8Array(400))).toBeNull();
    const [file] = syntheticCtSeries(1, 8);
    // Cut off inside the meta group.
    expect(dataSetOf(file.bytes.subarray(0, 150))).toBeNull();
  });
});
