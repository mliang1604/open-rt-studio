/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Many synthetic patients with next to nothing each: what a list of patients
// and studies needs in order to be searched, ordered and paged through. The
// names are trees, with "SYNTHETIC" as the given name; nobody is called that.

import type { SyntheticFile, SyntheticPatientIdentity, SyntheticStudy } from './identity.js';
import { syntheticCtSeries, syntheticMrSeries } from './image-series.js';

const FAMILY_NAMES = [
  'ALDER',
  'ASH',
  'BEECH',
  'BIRCH',
  'CEDAR',
  'CHERRY',
  'CYPRESS',
  'ELDER',
  'ELM',
  'FIR',
  'HAWTHORN',
  'HAZEL',
  'HOLLY',
  'HORNBEAM',
  'JUNIPER',
  'LARCH',
  'LINDEN',
  'MAPLE',
  'OAK',
  'PINE',
  'POPLAR',
  'ROWAN',
  'SPRUCE',
  'SYCAMORE',
  'WILLOW',
  'YEW',
] as const;

/** A study of the population, as a list of studies would show it. */
export interface PopulationStudy {
  readonly study: SyntheticStudy;
  readonly modality: 'CT' | 'MR';
}

/** How many patients {@link syntheticPopulation} writes. */
export const POPULATION_PATIENTS = FAMILY_NAMES.length;

/** Patient `n` of the population, from 0: `ALDER^SYNTHETIC`, `SYN-1000`, and so on by name. */
export function populationPatient(n: number): SyntheticPatientIdentity {
  return { id: `SYN-${1000 + n}`, name: `${FAMILY_NAMES[n]}^SYNTHETIC` };
}

const twoDigits = (n: number): string => String(n).padStart(2, '0');

/**
 * The studies of the population, in the order they are written:
 *
 * - every patient `n` has a CT study on day `n + 1` of January 2026;
 * - every third patient (0, 3, 6, ...) also has an MR study on day `n + 1`
 *   of March 2026.
 *
 * So there are {@link POPULATION_PATIENTS} CT studies and a third as many MR
 * studies, no two on the same day.
 */
export function populationStudies(): PopulationStudy[] {
  const studies: PopulationStudy[] = [];
  for (let n = 0; n < POPULATION_PATIENTS; n++) {
    const patient = populationPatient(n);
    studies.push({
      modality: 'CT',
      study: {
        index: 1000 + n,
        date: `202601${twoDigits(n + 1)}`,
        time: '090000',
        description: `Synthetic CT ${n + 1}`,
        patient,
      },
    });
    if (n % 3 === 0) {
      studies.push({
        modality: 'MR',
        study: {
          index: 2000 + n,
          date: `202603${twoDigits(n + 1)}`,
          time: '140000',
          description: `Synthetic MR ${n + 1}`,
          patient,
        },
      });
    }
  }
  return studies;
}

/**
 * The population as files: one series of one small image for each study of
 * {@link populationStudies}. Enough to be filed and listed; nothing to look at.
 */
export function syntheticPopulation(): SyntheticFile[] {
  return populationStudies().flatMap(({ study, modality }) =>
    (modality === 'CT' ? syntheticCtSeries : syntheticMrSeries)(1, 8, {
      study,
      namePrefix: `population-${study.index}-`,
    }),
  );
}
