/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readInstanceHeader } from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import {
  POPULATION_PATIENTS,
  populationPatient,
  populationStudies,
  syntheticPopulation,
} from './population.js';

describe('syntheticPopulation', () => {
  const studies = populationStudies();
  const headers = syntheticPopulation().map((file) => {
    const read = readInstanceHeader(file.bytes);
    if (!read.ok) throw new Error(`${file.name} has no header`);
    return read.header;
  });

  it('writes one file for each study it says it writes, in that order', () => {
    expect(headers).toHaveLength(studies.length);
    expect(
      headers.map((header) => [
        header.patient.id,
        header.patient.name,
        header.study.date,
        header.study.description,
        header.series.modality,
      ]),
    ).toEqual(
      studies.map(({ study, modality }) => [
        study.patient.id,
        study.patient.name,
        study.date,
        study.description,
        modality,
      ]),
    );
  });

  it('has a CT study for every patient and an MR study for every third', () => {
    expect(POPULATION_PATIENTS).toBeGreaterThan(20);
    expect(studies.filter((one) => one.modality === 'CT')).toHaveLength(POPULATION_PATIENTS);
    expect(studies.filter((one) => one.modality === 'MR')).toHaveLength(
      Math.ceil(POPULATION_PATIENTS / 3),
    );
    expect(studies.find((one) => one.modality === 'MR')!.study.patient).toEqual(
      populationPatient(0),
    );
  });

  it('gives every patient, study, series and instance an identifier of its own', () => {
    const distinct = (values: string[]): number => new Set(values).size;
    expect(distinct(headers.map((header) => header.patient.id))).toBe(POPULATION_PATIENTS);
    expect(distinct(headers.map((header) => header.patient.name ?? ''))).toBe(POPULATION_PATIENTS);
    expect(distinct(headers.map((header) => header.study.uid))).toBe(studies.length);
    expect(distinct(headers.map((header) => header.series.uid))).toBe(studies.length);
    expect(distinct(headers.map((header) => header.sopInstanceUid))).toBe(studies.length);
    // No two studies on the same day, so that an order by date is one order.
    expect(distinct(headers.map((header) => header.study.date ?? ''))).toBe(studies.length);
  });

  it('names its patients in alphabetical order, as synthetic', () => {
    const names = Array.from({ length: POPULATION_PATIENTS }, (_, n) => populationPatient(n).name);
    expect(names).toEqual([...names].sort());
    for (const name of names) expect(name).toMatch(/^[A-Z]+\^SYNTHETIC$/);
  });
});
