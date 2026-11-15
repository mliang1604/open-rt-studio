/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Patients whose names are outside ASCII (#249): a CT and a structure set
// drawn on it, in one study, every file written in the patient's character
// set and declaring it. The names are made up and are no one's.

import {
  seriesUid,
  SYNTHETIC_LATIN1_PATIENT,
  SYNTHETIC_UTF8_PATIENT,
  type SyntheticFile,
  type SyntheticPatientIdentity,
  type SyntheticStudy,
} from './identity.js';
import { syntheticCtSeries } from './image-series.js';
import { syntheticRtStruct } from './rtstruct.js';

/** The CT's series index, as `syntheticCtSeries` sets it. */
const CT_SERIES_INDEX = 1;

/** The study of a patient of {@link syntheticCharacterSetPatient}. */
export function characterSetStudy(patient: SyntheticPatientIdentity): SyntheticStudy {
  return {
    // Its own UIDs: of no other synthetic study.
    index: patient === SYNTHETIC_LATIN1_PATIENT ? 100 : 192,
    date: '20260410',
    time: '101500',
    description:
      patient === SYNTHETIC_LATIN1_PATIENT ? 'Étude de planification' : 'Étude 計画 study',
    patient,
  };
}

/**
 * A CT and a structure set on it, of a patient whose name is outside ASCII:
 * {@link SYNTHETIC_UTF8_PATIENT} by default, or {@link SYNTHETIC_LATIN1_PATIENT}.
 */
export function syntheticCharacterSetPatient(
  patient: SyntheticPatientIdentity = SYNTHETIC_UTF8_PATIENT,
  slices = 8,
  size = 32,
): SyntheticFile[] {
  const study = characterSetStudy(patient);
  return [
    ...syntheticCtSeries(slices, size, { study }),
    syntheticRtStruct(slices, 2, {
      study,
      referencedSeriesUid: seriesUid(study, CT_SERIES_INDEX),
    }),
  ];
}
