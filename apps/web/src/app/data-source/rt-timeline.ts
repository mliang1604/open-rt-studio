/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { relateRtObjects, type PlanStructures, type RtObjectFacts } from '@open-rt-studio/dicom';

import type { PatientHistory } from './data-source';

/**
 * A patient's history with what belongs to what: each structure set, plan
 * and dose with its image series, the registrations as links, and what
 * belongs to nothing listed with its study, or with the patient when its
 * study is not listed. `structures` are the structure sets that are at
 * hand, by which a plan's prescription names its structure (#97).
 */
export function withRelations(
  history: PatientHistory,
  objects: readonly RtObjectFacts[],
  structures: readonly PlanStructures[] = [],
): PatientHistory {
  const images = history.studies
    .flatMap((study) => study.series)
    .filter((series) => series.modality?.toUpperCase() !== 'RTDOSE');
  const relations = relateRtObjects(images, objects, structures);
  const listed = new Set(history.studies.map((study) => study.studyUid));
  const elsewhere = [...relations.byStudy]
    .filter(([studyUid]) => !listed.has(studyUid))
    .flatMap(([, loose]) => loose);
  return {
    ...history,
    studies: history.studies.map((study) => {
      const loose = relations.byStudy.get(study.studyUid);
      return {
        ...study,
        series: study.series.map((series) => {
          const attached = relations.bySeries.get(series.uid);
          return attached ? { ...series, attached } : series;
        }),
        ...(loose ? { loose } : {}),
      };
    }),
    links: relations.links,
    ...(elsewhere.length > 0 ? { loose: elsewhere } : {}),
  };
}
