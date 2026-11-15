/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A resampled image as the files of a new DICOM series (#89): what the
// series is called, what it says of how it was made, and what it is filed
// under. The series is of the base image's patient, in the base image's
// study and frame of reference, since it is on the base image's grid.

import {
  CT_IMAGE_SOP_CLASS,
  MR_IMAGE_SOP_CLASS,
  registrationReference,
  writeDerivedSeries,
  type DerivedSeriesContent,
  type LayerPlacement,
  type PlacementStep,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';

import type { SavedSeries } from '../../data-source/data-source';
import { timestampSlug } from '../capture';
import { registrationName } from '../layers-store';

/** What every derived series says of where it is from. */
export const DERIVED_NOTICE =
  'Made with Open RT Studio, which is not a medical device. Not for clinical use.';

/** What a series is called where a few words must do. */
export const nameOf = (series: Series): string =>
  series.description?.trim() || series.modality?.trim() || 'image';

/**
 * The new series' description. That it is resampled comes first, so that it
 * is still said where only the start of a description is shown, and when the
 * 64 characters DICOM allows cut the rest short.
 */
export function resampledDescription(source: Series, base: Series): string {
  return `Resampled: ${nameOf(source)} onto ${nameOf(base)}`;
}

/**
 * What a series' first image says of itself that an image made from it says
 * again: the kind of object it is, and how it was scanned. From the
 * metadata the viewer keeps, where a value is text as the file has it.
 */
export function sourceOf(series: Series): DerivedSeriesContent['source'] {
  const attributes: Record<string, string> = {};
  for (const tag of series.metadata?.rawTags ?? []) attributes[tag.tag.toLowerCase()] = tag.value;
  const sopClass = attributes['(0008,0016)']?.trim() ?? '';
  return {
    studyInstanceUid: series.studyUid,
    seriesInstanceUid: series.uid,
    sopClassUid: /^[0-9]+(\.[0-9]+)*$/.test(sopClass) ? sopClass : null,
    attributes,
  };
}

/** Specific Character Set of a series' first image, or null. */
function characterSetOf(series: Series): string | null {
  const tag = series.metadata?.rawTags.find((one) => one.tag.toLowerCase() === '(0008,0005)');
  return tag?.value.trim() || null;
}

/** A matrix as numbers in a row, to six places. */
const matrixText = (matrix: readonly number[]): string =>
  matrix.map((value) => String(Math.round(value * 1e6) / 1e6)).join(' ');

function stepText(step: PlacementStep, placement: LayerPlacement): string {
  if (step.byHand) {
    return `a registration made by hand in the viewer that is in no object (base to source, row by row: ${matrixText(placement.baseToLayer)})`;
  }
  const how = [
    step.inverted ? 'inverted' : 'as written',
    ...(step.deformable ? ['by its deformation field'] : []),
  ].join(', ');
  return `registration "${registrationName(step)}" (${step.sopInstanceUid}, ${how})`;
}

/**
 * The registrations something was taken through, in words: each by name and
 * UID and the way it was taken, or that none was needed. Null for two images
 * that share a frame of reference.
 */
export function throughText(placement: LayerPlacement | null): string {
  return placement
    ? `through ${placement.steps.map((step) => stepText(step, placement)).join(', then ')}`
    : 'with no registration: the two series share a frame of reference';
}

export interface DerivationFacts {
  readonly source: Series;
  readonly base: Series;
  /** Null when the two images share a frame of reference. */
  readonly placement: LayerPlacement | null;
  /** How many voxels are outside the source, of how many, and the value they were given. */
  readonly outsideCount: number;
  readonly voxelCount: number;
  readonly outside: number;
  /** Slices the source lacks and the viewer filled in, when it has any. */
  readonly missingSlices: number;
}

/** How a resampled image was derived, in words: what its Derivation Description says. */
export function derivationText(facts: DerivationFacts): string {
  const through = throughText(facts.placement);
  const missing =
    facts.missingSlices > 0
      ? ` The source lacks ${facts.missingSlices} slice${facts.missingSlices === 1 ? '' : 's'}, filled in by interpolation before it was resampled.`
      : '';
  return (
    `${DERIVED_NOTICE} Series ${facts.source.uid} resampled onto the grid of series ${facts.base.uid} ` +
    `by linear interpolation, ${through}. ${facts.outsideCount} of ${facts.voxelCount} voxels lie ` +
    `outside the source and were given ${facts.outside}.${missing}`
  );
}

/** A resampled image as files, and what to tell of it. */
export interface DerivedFiles {
  readonly series: SavedSeries;
  /** The new series' description: what it goes by. */
  readonly description: string;
  readonly seriesInstanceUid: string;
  /** What kind of object the slices are, in a word or two. */
  readonly kind: string;
  /** How many values 16 bits could not hold. */
  readonly clampedCount: number;
}

const KINDS: Readonly<Record<string, string>> = {
  [CT_IMAGE_SOP_CLASS]: 'CT images',
  [MR_IMAGE_SOP_CLASS]: 'MR images',
};

/**
 * Write a resampled image as the files of a new series. `frameOfReferenceUid`
 * and `studyInstanceUid` are the base image's, which whoever calls has
 * made sure it has.
 */
export function derivedFiles(
  resampled: Volume,
  facts: DerivationFacts,
  filed: { readonly frameOfReferenceUid: string; readonly studyInstanceUid: string },
  now: Date,
): DerivedFiles {
  const { base, source, placement } = facts;
  const description = resampledDescription(source, base);
  const written = writeDerivedSeries(
    {
      volume: resampled,
      frameOfReferenceUid: filed.frameOfReferenceUid,
      patientName: base.patientName,
      patientId: base.patientId,
      specificCharacterSet: characterSetOf(base),
      studyInstanceUid: filed.studyInstanceUid,
      studyDate: base.studyDate,
      studyTime: base.studyTime,
      studyDescription: base.studyDescription,
      seriesDescription: description,
      seriesNumber: null,
      source: sourceOf(source),
      registrations: (placement?.steps ?? [])
        .filter((step) => !step.byHand && step.sopInstanceUid !== '')
        .map((step) => registrationReference(step.sopInstanceUid, !!step.deformable)),
      derivationDescription: derivationText(facts),
    },
    { createdAt: now },
  );
  return {
    description,
    seriesInstanceUid: written.seriesInstanceUid,
    kind: KINDS[written.sopClassUid] ?? 'Secondary Capture images',
    clampedCount: written.clampedCount,
    series: {
      // What it is and when it was made, and nothing of the patient.
      name: `resampled-series-${timestampSlug(now)}`,
      made: now,
      objects: written.instances.map((instance) => ({
        bytes: instance.bytes,
        filename: `IM${String(instance.instanceNumber).padStart(4, '0')}.dcm`,
        mediaType: 'application/dicom',
      })),
    },
  };
}
