/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  chooseTransferSyntax,
  EXPLICIT_VR_LE,
  IMPLICIT_VR_LE,
  isAeTitle,
  STORAGE_SOP_CLASSES,
  TRANSFER_SYNTAXES,
} from './sop-classes.js';
import { isUid } from '../uid.js';

describe('chooseTransferSyntax', () => {
  it('prefers Explicit VR Little Endian, then Implicit, whatever the order offered', () => {
    expect(chooseTransferSyntax([IMPLICIT_VR_LE, EXPLICIT_VR_LE])).toBe(EXPLICIT_VR_LE);
    expect(chooseTransferSyntax(['1.2.840.10008.1.2.4.70', IMPLICIT_VR_LE])).toBe(IMPLICIT_VR_LE);
  });

  it('takes a compressed syntax the viewer decodes when that is all that is offered', () => {
    expect(chooseTransferSyntax(['1.2.840.10008.1.2.4.70'])).toBe('1.2.840.10008.1.2.4.70');
  });

  it('takes none of what it cannot keep and read', () => {
    // Big endian, deflated, MPEG-2.
    expect(
      chooseTransferSyntax([
        '1.2.840.10008.1.2.2',
        '1.2.840.10008.1.2.1.99',
        '1.2.840.10008.1.2.4.100',
      ]),
    ).toBeNull();
    expect(chooseTransferSyntax([])).toBeNull();
  });
});

describe('what the listener takes', () => {
  it('is named by UIDs', () => {
    for (const uid of [...Object.keys(STORAGE_SOP_CLASSES), ...TRANSFER_SYNTAXES]) {
      expect(isUid(uid), uid).toBe(true);
    }
  });

  it('includes the radiotherapy objects and both registrations', () => {
    expect(Object.values(STORAGE_SOP_CLASSES)).toEqual(
      expect.arrayContaining([
        'CT Image',
        'MR Image',
        'RT Dose',
        'RT Structure Set',
        'RT Plan',
        'Spatial Registration',
        'Deformable Spatial Registration',
      ]),
    );
  });
});

describe('isAeTitle', () => {
  it('takes 1 to 16 printable characters', () => {
    expect(isAeTitle('OPENRTSTUDIO')).toBe(true);
    expect(isAeTitle('A')).toBe(true);
    expect(isAeTitle('Planning System1')).toBe(true);
  });

  it('refuses the empty, the long, a backslash, control characters and spaces at the ends', () => {
    expect(isAeTitle('')).toBe(false);
    expect(isAeTitle('SEVENTEEN-LETTERS')).toBe(false);
    expect(isAeTitle('A\\B')).toBe(false);
    expect(isAeTitle('A\nB')).toBe(false);
    expect(isAeTitle(' PADDED')).toBe(false);
    expect(isAeTitle('É')).toBe(false);
  });
});
