/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PatientHistory, SeriesSummary } from './data-source/data-source';
import { demoPatient, demoPlanningCt, type DemoPatient } from './demo-data';

const series = (modality: string): SeriesSummary => ({ modality }) as SeriesSummary;

function patient(
  patientId: string,
  studies: { date: string; modalities: string[] }[],
): PatientHistory {
  return {
    key: patientId,
    patientId,
    name: null,
    studies: studies.map((s, i) => ({
      studyUid: String(i),
      date: s.date,
      description: null,
      modalities: s.modalities,
      series: s.modalities.map(series),
    })),
  };
}

const DEMO: DemoPatient = { files: [], patientId: 'SYN-0002', planningStudyDate: '20260202' };

describe('demoPlanningCt', () => {
  it('finds the CT of the planning study', () => {
    const record = patient('SYN-0002', [
      { date: '20260202', modalities: ['MR', 'CT', 'RTDOSE'] },
      { date: '20260511', modalities: ['CT'] },
    ]);
    const found = demoPlanningCt(record, DEMO);
    expect(found?.modality).toBe('CT');
    expect(found).toBe(record.studies[0].series[1]);
  });

  it('is null when another patient, or nothing, is in the catalog', () => {
    expect(demoPlanningCt(null, DEMO)).toBeNull();
    expect(
      demoPlanningCt(patient('OTHER', [{ date: '20260202', modalities: ['CT'] }]), DEMO),
    ).toBeNull();
    expect(
      demoPlanningCt(patient('SYN-0002', [{ date: '20260511', modalities: ['CT'] }]), DEMO),
    ).toBeNull();
  });
});

describe('demoPatient', () => {
  it('generates DICOM files for a patient that is marked synthetic', async () => {
    const demo = await demoPatient();
    expect(demo.patientId).toMatch(/^SYN-/);
    expect(demo.planningStudyDate).toMatch(/^\d{8}$/);
    // Planning CT and MR, the follow-up CT, one structure set and one dose.
    expect(demo.files.length).toBe(3 * 64 + 2);
    const head = new Uint8Array(await demo.files[0].slice(128, 132).arrayBuffer());
    expect(String.fromCharCode(...head)).toBe('DICM');
    expect(demo.files.every((f) => f.type === 'application/dicom')).toBe(true);
  });
});
