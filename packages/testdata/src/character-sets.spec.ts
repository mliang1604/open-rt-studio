/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  groupSeries,
  parseFile,
  parseStructureSet,
  readInstanceHeader,
  writeStructureSet,
} from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import { characterSetStudy, syntheticCharacterSetPatient } from './character-sets.js';
import {
  encodedText,
  SYNTHETIC_LATIN1_PATIENT,
  SYNTHETIC_UTF8_PATIENT,
  type SyntheticPatientIdentity,
} from './identity.js';

const MODALITY = (file: { bytes: Uint8Array }): string => {
  const read = readInstanceHeader(file.bytes);
  return read.ok ? read.header.series.modality : '';
};

describe.each([
  ['UTF-8', SYNTHETIC_UTF8_PATIENT],
  ['Latin-1', SYNTHETIC_LATIN1_PATIENT],
] as [string, SyntheticPatientIdentity][])(
  'a patient whose name is outside ASCII, in %s (#249)',
  (_, patient) => {
    const files = syntheticCharacterSetPatient(patient, 4, 16);
    const study = characterSetStudy(patient);

    it('is written in the character set it declares, and is not plain ASCII', () => {
      const name = encodedText(patient.name, patient.characterSet);
      expect(name.some((byte) => byte > 0x7f)).toBe(true);
      if (patient.characterSet === 'ISO_IR 192') {
        expect(new TextDecoder('utf-8', { fatal: true }).decode(name).trim()).toBe(patient.name);
      } else {
        // Latin-1: a byte to a character.
        expect(name.length).toBe(patient.name.length + (patient.name.length % 2));
      }
    });

    it('is read with its name and study description as they were written: header, slices, structure set', () => {
      for (const file of files) {
        const read = readInstanceHeader(file.bytes);
        if (!read.ok) throw new Error(read.reason);
        expect(read.header.patient.name).toBe(patient.name);
        expect(read.header.study.description).toBe(study.description);
      }
      const slices = files
        .filter((file) => MODALITY(file) === 'CT')
        .flatMap((file) => parseFile(file.name, file.bytes.slice().buffer));
      const [series] = groupSeries(slices);
      expect(series.patientName).toBe(patient.name);
      expect(series.studyDescription).toBe(study.description);
      const setFile = files.find((file) => MODALITY(file) === 'RTSTRUCT')!;
      const set = parseStructureSet(setFile.name, setFile.bytes.slice().buffer)!;
      expect(set.patientId).toBe(patient.id);
      expect(set.rois.length).toBeGreaterThan(0);
    });

    it('keeps its name when a structure set is written here and read again', () => {
      const setFile = files.find((file) => MODALITY(file) === 'RTSTRUCT')!;
      const set = parseStructureSet(setFile.name, setFile.bytes.slice().buffer)!;
      const written = writeStructureSet(
        { ...set, label: 'Édité ✓' },
        { patientName: patient.name, patientId: patient.id, studyInstanceUid: '1.2.3.4' },
      );
      const header = readInstanceHeader(new Uint8Array(written));
      if (!header.ok) throw new Error(header.reason);
      expect(header.header.patient.name).toBe(patient.name);
      expect(parseStructureSet('again.dcm', written)!.label).toBe('Édité ✓');
    });
  },
);

describe('the character sets of synthetic files', () => {
  it('refuses a character Latin-1 does not have, and writes ASCII as it is', () => {
    expect(() => encodedText('山田', 'ISO_IR 100')).toThrow('“山” is not in ISO_IR 100.');
    expect([...encodedText('ABC', undefined)]).toEqual([0x41, 0x42, 0x43, 0x20]);
    expect([...encodedText('ABC', 'ISO_IR 192')]).toEqual([0x41, 0x42, 0x43, 0x20]);
  });
});
