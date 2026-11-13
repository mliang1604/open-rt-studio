/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A whole synthetic patient: several series over two studies, for tests of the
// timeline, series picking and multi-series loading.

import { SYNTHETIC_FOLLOW_UP_STUDY, SYNTHETIC_STUDY, type SyntheticFile } from './identity.js';
import { syntheticCtSeries, syntheticMrSeries } from './image-series.js';
import { syntheticRtDose } from './rtdose.js';
import { syntheticRtStruct } from './rtstruct.js';

/**
 * One patient with two studies:
 *
 * - the planning study: CT, MR in the same Frame of Reference, RTSTRUCT and
 *   RTDOSE on the CT
 * - a follow-up study ten weeks later: one CT, in its own Frame of Reference
 *
 * Returned as one flat batch, like a folder a user would open.
 */
export function syntheticPatient(count = 12, size = 32): SyntheticFile[] {
  return [
    ...syntheticCtSeries(count, size),
    ...syntheticMrSeries(count, size),
    syntheticRtStruct(count),
    syntheticRtDose(Math.min(6, count), 12),
    ...syntheticCtSeries(count, size, {
      study: SYNTHETIC_FOLLOW_UP_STUDY,
      description: 'Synthetic follow-up CT',
    }),
  ];
}

/** The studies {@link syntheticPatient} contains, oldest first. */
export const SYNTHETIC_PATIENT_STUDIES = [SYNTHETIC_STUDY, SYNTHETIC_FOLLOW_UP_STUDY] as const;
