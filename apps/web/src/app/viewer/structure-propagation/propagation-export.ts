/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Structures taken to another image as a new RT Structure Set (#90): what
// the set is called, what it says of how it was made, and what it is filed
// under. It is drawn on the base image, so it is of the base image's
// patient, in its study and frame of reference, and references its series.

import {
  writeStructureSet,
  type LayerPlacement,
  type PropagatedRoi,
  type PropagationMethod,
  type Series,
  type StructureSet,
} from '@open-rt-studio/dicom';

import { timestampSlug } from '../capture';
import { DERIVED_NOTICE, nameOf, throughText } from '../derived-series/derived-export';

/** The Structure Set Label of every set made by propagation. */
export const PROPAGATED_LABEL = 'PROPAGATED';

/** What each structure says of the way it was taken: its ROI Generation Description. */
export const METHOD_TEXT: Readonly<Record<PropagationMethod, string>> = {
  points: 'Propagated: points moved by the registration',
  'label-volume': 'Propagated: label volume resampled and outlined',
};

/** What a structure set goes by: its label, or that it has none. */
export const setName = (set: StructureSet): string => set.label?.trim() || 'unlabelled';

export interface PropagationFacts {
  /** The structure set the structures are from, and the series it is drawn on. */
  readonly set: StructureSet;
  readonly source: Series;
  /** The series they are taken to. */
  readonly base: Series;
  /** Null when the two images share a frame of reference. */
  readonly placement: LayerPlacement | null;
  readonly results: readonly PropagatedRoi[];
}

const count = (results: readonly PropagatedRoi[], method: PropagationMethod): number =>
  results.filter((one) => one.method === method).length;

/** The new set's series description: that it is propagated comes first. */
export function propagatedDescription(set: StructureSet, base: Series): string {
  return `Propagated: ${setName(set)} onto ${nameOf(base)}`;
}

/** How the set was made, in words: its Structure Set Description. */
export function propagationText(facts: PropagationFacts): string {
  const { set, source, base, results } = facts;
  const from = set.sopInstanceUid ? ` (${set.sopInstanceUid})` : '';
  return (
    `${DERIVED_NOTICE} Structures of structure set "${setName(set)}"${from} on series ${source.uid} ` +
    `taken to series ${base.uid} ${throughText(facts.placement)}. ` +
    `${count(results, 'points')} by moving their points, ` +
    `${count(results, 'label-volume')} by a label volume resampled and outlined.`
  );
}

/** The propagated structures as a structure set on the base image. */
export function propagatedSet(facts: PropagationFacts, frameOfReferenceUid: string): StructureSet {
  return {
    name: 'propagated-structures.dcm',
    label: PROPAGATED_LABEL,
    frameOfReferenceUid,
    referencedSeriesUids: [facts.base.uid],
    patientId: facts.base.patientId,
    rois: facts.results.map((one) => ({
      ...one.roi,
      generation: { algorithm: 'AUTOMATIC', description: METHOD_TEXT[one.method], resampled: true },
    })),
  };
}

/** A propagated structure set as a file, and what to tell of it. */
export interface PropagatedFile {
  readonly bytes: ArrayBuffer;
  readonly filename: string;
  /** The set's series description: what it goes by. */
  readonly description: string;
}

/** Text as plain ASCII: a character outside it becomes `?`. */
const plain = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?');

/**
 * Write propagated structures as a new RT Structure Set. `filed` is the base
 * image's frame of reference and study, which whoever calls has made sure
 * it has.
 */
export function propagatedFile(
  facts: PropagationFacts,
  filed: { readonly frameOfReferenceUid: string; readonly studyInstanceUid: string },
  now: Date,
): PropagatedFile {
  const { base, set } = facts;
  const description = propagatedDescription(set, base);
  const bytes = writeStructureSet(propagatedSet(facts, filed.frameOfReferenceUid), {
    patientName: base.patientName,
    patientId: base.patientId,
    studyInstanceUid: filed.studyInstanceUid,
    studyDate: base.studyDate,
    studyTime: base.studyTime,
    studyDescription: base.studyDescription,
    seriesDescription: plain(description).slice(0, 64),
    description: plain(propagationText(facts)).slice(0, 1024),
    predecessorSopInstanceUid: set.sopInstanceUid,
    createdAt: now,
  });
  // What it is and when it was made, and nothing of the patient.
  return { bytes, filename: `propagated-structures-${timestampSlug(now)}.dcm`, description };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What was made, in words, for whoever is about to save it. */
export function propagationSummary(set: StructureSet, results: readonly PropagatedRoi[]): string {
  const parts = [
    `Propagated, not saved: ${plural(results.length, 'structure', 'structures')} of “${setName(set)}” onto the base image’s slices.`,
  ];
  const [points, volume] = [count(results, 'points'), count(results, 'label-volume')];
  const ways = [
    ...(points > 0 ? [`${points} by moving ${points === 1 ? 'its' : 'their'} points`] : []),
    ...(volume > 0 ? [`${volume} by a label volume`] : []),
  ];
  if (ways.length > 0) parts.push(`${ways.join(', ')}.`);
  // A structure that had contours and has none here: said by name.
  const gone = results.filter((one) => one.sourceContours > 0 && one.roi.contours.length === 0);
  if (gone.length > 0) {
    parts.push(
      `${gone.map((one) => `“${one.roi.name}”`).join(', ')} ${gone.length === 1 ? 'has' : 'have'} no contour on this image.`,
    );
  }
  const leftOut = results.reduce((sum, one) => sum + one.leftOut, 0);
  if (leftOut > 0) {
    parts.push(
      `${plural(leftOut, 'contour was', 'contours were')} left out: beyond the image’s slices, or open and so around nothing.`,
    );
  }
  return parts.join(' ');
}
