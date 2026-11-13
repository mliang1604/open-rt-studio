/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PatientRecord, Series } from '@open-rt-studio/dicom';

/** The synthetic demo patient as browser files, with what identifies its planning CT. */
export interface DemoPatient {
  readonly files: File[];
  readonly patientId: string;
  /** Study date (DICOM DA) of the planning study, whose CT is shown first. */
  readonly planningStudyDate: string;
}

/**
 * Generate the synthetic thorax phantom in the browser. The generators are
 * imported on demand, so they are downloaded only when someone asks for the
 * demo and do not add to the initial bundle. Every byte is fabricated by
 * `@open-rt-studio/testdata`; nothing here is, or is derived from, patient data.
 */
export async function demoPatient(): Promise<DemoPatient> {
  const testdata = await import('@open-rt-studio/testdata');
  const files = testdata
    .syntheticThoraxPatient()
    .map((f) => new File([f.bytes.slice().buffer], f.name, { type: f.mimeType }));
  return {
    files,
    patientId: testdata.THORAX_PATIENT.id,
    planningStudyDate: testdata.THORAX_PLANNING_STUDY.date,
  };
}

/** The planning CT of the demo patient in the catalog, or null when it is not there. */
export function demoPlanningCt(patient: PatientRecord | null, demo: DemoPatient): Series | null {
  if (!patient || patient.patientId !== demo.patientId) return null;
  const study = patient.studies.find((s) => s.date === demo.planningStudyDate);
  return study?.series.find((s) => s.modality === 'CT') ?? null;
}
