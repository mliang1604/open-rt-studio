/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readInstanceHeader } from './instance-header.js';

// Reading real headers is tested where the files are made: the specs of
// packages/testdata read back what its generators write. Here: what is not a
// file that can be filed.

/** A Part 10 file, explicit VR little endian, with these elements after the meta group. */
function part10(elements: readonly [group: number, element: number, vr: string, value: string][]) {
  const encode = ([group, element, vr, value]: (typeof elements)[number]): Uint8Array => {
    const padded = value.length % 2 === 0 ? value : value + (vr === 'UI' ? '\0' : ' ');
    const bytes = new Uint8Array(8 + padded.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, group, true);
    view.setUint16(2, element, true);
    bytes[4] = vr.charCodeAt(0);
    bytes[5] = vr.charCodeAt(1);
    view.setUint16(6, padded.length, true);
    for (let i = 0; i < padded.length; i++) bytes[8 + i] = padded.charCodeAt(i);
    return bytes;
  };
  const join = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const meta = encode([0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1']);
  const groupLength = new Uint8Array(12);
  const view = new DataView(groupLength.buffer);
  view.setUint16(0, 0x0002, true);
  view.setUint16(2, 0x0000, true);
  groupLength[4] = 0x55; // U
  groupLength[5] = 0x4c; // L
  view.setUint16(6, 4, true);
  view.setUint32(8, meta.length, true);
  const magic = new Uint8Array(132);
  magic.set([0x44, 0x49, 0x43, 0x4d], 128); // DICM
  return join([magic, groupLength, meta, ...elements.map(encode)]);
}

const WHOLE: [number, number, string, string][] = [
  [0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.2'],
  [0x0008, 0x0018, 'UI', '1.2.3.4'],
  [0x0020, 0x000d, 'UI', '1.2.3'],
  [0x0020, 0x000e, 'UI', '1.2.3.1'],
];

describe('readInstanceHeader', () => {
  it.each([
    ['nothing', new Uint8Array()],
    ['text', new TextEncoder().encode('This is not a DICOM file. '.repeat(20))],
    ['zeros', new Uint8Array(4096)],
  ])('says "not-dicom" for %s', (_what, bytes) => {
    expect(readInstanceHeader(bytes)).toEqual({ ok: false, reason: 'not-dicom' });
  });

  it('reads a file with the four UIDs and nothing else, with defaults for the rest', () => {
    expect(readInstanceHeader(part10(WHOLE))).toEqual({
      ok: true,
      header: {
        sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
        sopInstanceUid: '1.2.3.4',
        transferSyntaxUid: '1.2.840.10008.1.2.1',
        patient: { id: '', issuer: '', name: null, birthDate: null, sex: null },
        study: { uid: '1.2.3', date: null, time: null, description: null, accessionNumber: null },
        series: {
          uid: '1.2.3.1',
          modality: 'OT',
          number: null,
          description: null,
          frameOfReferenceUid: null,
        },
        instanceNumber: null,
        frames: null,
        references: [],
      },
    });
  });

  it.each([
    ['49', 49],
    ['1', 1],
    // Not a count of images: taken as not said.
    ['0', null],
    ['-3', null],
    ['2.5', null],
    ['many', null],
  ])('reads Number of Frames %j as %j', (written, frames) => {
    const result = readInstanceHeader(
      part10([...WHOLE, [0x0028, 0x0008, 'IS', written] as (typeof WHOLE)[number]]),
    );
    expect(result).toMatchObject({ ok: true, header: { frames } });
  });

  it.each(WHOLE.map((element, index) => [element[1].toString(16), index] as const))(
    'says "incomplete" without the UID (....,%s)',
    (_tag, index) => {
      const without = WHOLE.filter((_, i) => i !== index);
      expect(readInstanceHeader(part10(without))).toEqual({ ok: false, reason: 'incomplete' });
    },
  );

  it('says "incomplete" when a UID is not one', () => {
    const spoiled = WHOLE.map((element): (typeof WHOLE)[number] =>
      element[1] === 0x000e ? [element[0], element[1], element[2], '../../etc'] : element,
    );
    expect(readInstanceHeader(part10(spoiled))).toEqual({ ok: false, reason: 'incomplete' });
  });

  it('reads the patient, with the issuer, and upper-cases the modality', () => {
    const result = readInstanceHeader(
      part10([
        ...WHOLE.slice(0, 2),
        [0x0008, 0x0050, 'SH', 'ACC-7'],
        [0x0008, 0x0060, 'CS', 'mr'],
        [0x0010, 0x0010, 'PN', 'SYNTHETIC^PHANTOM'],
        [0x0010, 0x0020, 'LO', 'SYN-0001'],
        [0x0010, 0x0021, 'LO', 'Synthetic Hospital'],
        [0x0010, 0x0030, 'DA', '19700101'],
        [0x0010, 0x0040, 'CS', 'O'],
        ...WHOLE.slice(2),
        [0x0020, 0x0011, 'IS', '7'],
        [0x0020, 0x0013, 'IS', 'x'],
      ]),
    );
    expect(result).toMatchObject({
      ok: true,
      header: {
        patient: {
          id: 'SYN-0001',
          issuer: 'Synthetic Hospital',
          name: 'SYNTHETIC^PHANTOM',
          birthDate: '19700101',
          sex: 'O',
        },
        study: { accessionNumber: 'ACC-7' },
        series: { modality: 'MR', number: 7 },
        // Not a number, so none.
        instanceNumber: null,
      },
    });
  });
});
