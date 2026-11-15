/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A sum that was made, as an RT Dose file (#101): what it is filed under,
// what it says of the doses it is a sum of, and what is told of it once it
// is saved. The dose is of the image's patient, in the image's study and
// frame of reference, since it is on the image's grid.

import {
  doseSumAsciiName,
  type LayerPlacement,
  matrixKind,
  registrationReference,
  type Series,
  seriesInstanceUidOf,
  type SummedDoseSource,
  type Volume,
  writeSummedDose,
  type WrittenDose,
} from '@open-rt-studio/dicom';

import type { SavedObject } from '../../data-source/data-source';
import { timestampSlug } from '../capture';
import { DERIVED_NOTICE, characterSetOf, throughText } from '../derived-series/derived-export';
import type { SumMade } from './dose-sum-model';

/** One dose a sum was made of, as it was when the sum was made. */
export interface SummedOf {
  readonly volume: Volume;
  readonly placement: LayerPlacement | undefined;
  /** SOP Instance UIDs of the plans the dose names. */
  readonly planUids: readonly string[];
}

/**
 * How a placement moved a dose: by a rigid transformation, or by anything
 * else. A matrix that scales or shears is not rigid, and neither is
 * anything with a deformation field.
 */
export function transformOf(placement: LayerPlacement | undefined): SummedDoseSource['transform'] {
  if (!placement) return 'none';
  if (placement.field || placement.steps.some((step) => step.deformable)) return 'non-rigid';
  return matrixKind(placement.baseToLayer) === 'rigid' ? 'rigid' : 'non-rigid';
}

/** A dose of a sum as the file refers to it: by its object, its plans and its registrations. */
export function sourceOf(of: SummedOf): SummedDoseSource {
  return {
    sopInstanceUid: of.volume.dose?.sopInstanceUid ?? null,
    planUids: of.planUids,
    registrations: (of.placement?.steps ?? [])
      .filter((step) => !step.byHand && step.sopInstanceUid !== '')
      .map((step) => registrationReference(step.sopInstanceUid, !!step.deformable)),
    transform: transformOf(of.placement),
  };
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How a sum was made, in words: what its Derivation Description says. What
 * matters most comes first, since only 1024 characters are written: that it
 * is not for clinical use, what kind of sum it is and with what α/β, then
 * each dose. Written without the letters α and β, which the element cannot
 * be relied on to hold.
 */
export function sumDerivationText(
  said: SumMade,
  of: readonly SummedOf[],
  base: Pick<Series, 'uid'>,
): string {
  const { made } = said;
  const what =
    made.model === 'physical'
      ? `Sum of ${count(made.doses, 'physical dose', 'physical doses')}, each as it is`
      : `${doseSumAsciiName(made)}: sum of ${count(made.doses, 'dose', 'doses')}, each converted ` +
        'voxel by voxel by the linear-quadratic model, taken to be given in equal fractions, before it was added';
  let ratios = '';
  if (made.model !== 'physical' && said.alphaBeta) {
    const structures = said.alphaBeta.structures
      .filter((one) => one.alphaBetaGy !== null)
      .map((one) => `${one.name} ${one.alphaBetaGy} Gy`);
    const outside =
      said.alphaBeta.outsideGy === null
        ? 'none outside them'
        : `${said.alphaBeta.outsideGy} Gy outside them`;
    ratios = ` alpha/beta by structure, the first having a voxel two are in: ${[...structures, outside].join(', ')}.`;
  }
  const doses = said.doses.map((dose, index) => {
    const one = of[index];
    const parts = [
      `object ${one?.volume.dose?.sopInstanceUid ?? 'with no UID'}`,
      ...(dose.fractions === null ? [] : [count(dose.fractions, 'fraction', 'fractions')]),
      `weight ${dose.weight}`,
      throughText(one?.placement ?? null),
      ...(dose.beyond === 'nothing' ? ['taken for no dose beyond its grid'] : []),
    ];
    return ` Dose ${index + 1}: ${parts.join(', ')}.`;
  });
  const known =
    said.known >= said.voxels
      ? ' The sum is known at every voxel of that grid.'
      : ` The sum is known at ${said.known} of the ${said.voxels} voxels of that grid; 0 is stored where it is not known, which is not a dose of zero.`;
  return `${DERIVED_NOTICE} ${what}, on the grid of series ${seriesInstanceUidOf(base.uid)}.${ratios}${known}${doses.join('')}`;
}

/** A sum as a file, and what was written. */
export interface SummedDoseFile {
  readonly object: SavedObject;
  readonly written: WrittenDose;
}

/**
 * Write a sum as an RT Dose file. `frameOfReferenceUid` and
 * `studyInstanceUid` are the image's, which whoever calls has made sure it
 * has. Doses with no weight added nothing and are not referred to.
 */
export function summedDoseFile(
  sum: Volume,
  said: SumMade,
  of: readonly SummedOf[],
  base: Series,
  filed: { readonly frameOfReferenceUid: string; readonly studyInstanceUid: string },
  now: Date,
): SummedDoseFile {
  const written = writeSummedDose(
    {
      volume: sum,
      frameOfReferenceUid: filed.frameOfReferenceUid,
      patientName: base.patientName,
      patientId: base.patientId,
      specificCharacterSet: characterSetOf(base),
      studyInstanceUid: filed.studyInstanceUid,
      studyDate: base.studyDate,
      studyTime: base.studyTime,
      studyDescription: base.studyDescription,
      seriesNumber: null,
      sources: of.filter((_, index) => (said.doses[index]?.weight ?? 0) > 0).map(sourceOf),
      derivationDescription: sumDerivationText(said, of, base),
    },
    { createdAt: now },
  );
  return {
    written,
    object: {
      bytes: written.bytes,
      // What it is and when it was made, and nothing of the patient.
      filename: `summed-dose-${timestampSlug(now)}.dcm`,
      mediaType: 'application/dicom',
    },
  };
}

/**
 * What a file holds that whoever saved it should know, in sentences: none
 * when there is nothing to tell.
 */
export function writtenNotes(written: WrittenDose): string[] {
  const notes: string[] = [];
  if (written.unknownCount > 0) {
    notes.push(
      'Where the sum is not known the file holds 0, as an RT Dose must. Open RT Studio reads back which voxels those are; another program will read a dose of 0 there.',
    );
  }
  if (written.plansNotNamed > 0) {
    notes.push(
      `${count(written.plansNotNamed, 'dose names', 'doses name')} no plan, so the file lacks a reference to a plan that the standard asks for.`,
    );
  }
  return notes;
}
