/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';

/**
 * How one object refers to another; the target is a UID of the kind after
 * the dot.
 *
 * - `structure-set.series`: an RTSTRUCT, to the image series it was drawn on
 * - `structure-set.frame`: an RTSTRUCT, to the frame of reference its contours are in
 * - `plan.structure-set`: an RTPLAN, to the RTSTRUCT instance it was planned on
 * - `dose.plan`: an RTDOSE, to the RTPLAN instance it was computed for
 * - `dose.structure-set`: an RTDOSE, to an RTSTRUCT instance
 * - `registration.frame`: a registration, to a frame of reference it connects
 * - `registration.series`: a registration, to a series it connects
 */
export type InstanceRelation =
  | 'structure-set.series'
  | 'structure-set.frame'
  | 'plan.structure-set'
  | 'dose.plan'
  | 'dose.structure-set'
  | 'registration.frame'
  | 'registration.series';

export interface InstanceReference {
  readonly relation: InstanceRelation;
  readonly targetUid: string;
}

/**
 * What a file says it is and where it belongs, without its pixels: enough to
 * file it under a patient, a study and a series, and to know which other
 * objects it refers to.
 */
export interface InstanceHeader {
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  readonly transferSyntaxUid: string | null;
  readonly patient: {
    /** Patient ID; '' when the file gives none. */
    readonly id: string;
    /** Issuer of Patient ID; '' when the file gives none. */
    readonly issuer: string;
    /** Patient's Name as the DICOM PN text (`family^given`). */
    readonly name: string | null;
    /** `YYYYMMDD`. */
    readonly birthDate: string | null;
    readonly sex: string | null;
  };
  readonly study: {
    readonly uid: string;
    /** `YYYYMMDD`. */
    readonly date: string | null;
    readonly time: string | null;
    readonly description: string | null;
    readonly accessionNumber: string | null;
  };
  readonly series: {
    readonly uid: string;
    /** `OT` (other) when the file gives none. */
    readonly modality: string;
    readonly number: number | null;
    readonly description: string | null;
    /** Frame of Reference UID (0020,0052) of the object itself. */
    readonly frameOfReferenceUid: string | null;
  };
  readonly instanceNumber: number | null;
  /**
   * Number of Frames (0028,0008): how many images the one file holds, as an
   * enhanced image or a dose grid does. Null when the file does not say, or
   * says something that is not a count; it then holds one image, if any.
   */
  readonly frames: number | null;
  /** What the object refers to, each reference once. Empty for an image. */
  readonly references: readonly InstanceReference[];
}

/**
 * A header, or why there is none: the bytes are not a DICOM file
 * (`not-dicom`), or they are one that cannot be filed because it lacks a SOP
 * Class, SOP Instance, Study or Series UID (`incomplete`), as a DICOMDIR does.
 */
export type InstanceHeaderResult =
  | { readonly ok: true; readonly header: InstanceHeader }
  | { readonly ok: false; readonly reason: 'not-dicom' | 'incomplete' };

const RT_STRUCTURE_SET = '1.2.840.10008.5.1.4.1.1.481.3';
const RT_DOSE = '1.2.840.10008.5.1.4.1.1.481.2';
/** RT Plan, RT Ion Plan. */
const RT_PLANS = new Set(['1.2.840.10008.5.1.4.1.1.481.5', '1.2.840.10008.5.1.4.1.1.481.8']);
/** Spatial Registration, Deformable Spatial Registration. */
const REGISTRATIONS = new Set(['1.2.840.10008.5.1.4.1.1.66.1', '1.2.840.10008.5.1.4.1.1.66.3']);

const UID = /^[0-9]+(\.[0-9]+)*$/;

/** A UID element's value, or null when it is absent or not a UID. */
function uid(dataSet: DataSet, tag: string): string | null {
  const value = dataSet.string(tag)?.trim();
  return value && value.length <= 64 && UID.test(value) ? value : null;
}

/** A text element's value, or null when it is absent or blank. */
function text(dataSet: DataSet, tag: string): string | null {
  return dataSet.string(tag)?.trim() || null;
}

/** An integer string's value, or null when it is absent or not a number. */
function integer(dataSet: DataSet, tag: string): number | null {
  const value = Number(text(dataSet, tag) ?? NaN);
  return Number.isInteger(value) ? value : null;
}

/** An integer string's value when it is one or more; null otherwise. */
function count(dataSet: DataSet, tag: string): number | null {
  const value = integer(dataSet, tag);
  return value !== null && value >= 1 ? value : null;
}

function items(dataSet: DataSet, tag: string): DataSet[] {
  return (dataSet.elements[tag]?.items ?? []).flatMap((item) =>
    item.dataSet ? [item.dataSet] : [],
  );
}

/** Collects references, each one once, in the order they are found. */
class References {
  private readonly seen = new Set<string>();
  readonly list: InstanceReference[] = [];

  add(relation: InstanceRelation, targetUid: string | null): void {
    if (targetUid === null) return;
    const key = `${relation} ${targetUid}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ relation, targetUid });
  }
}

function structureSetReferences(dataSet: DataSet, references: References): void {
  // ReferencedFrameOfReferenceSequence > RTReferencedStudySequence > RTReferencedSeriesSequence
  for (const frame of items(dataSet, 'x30060010')) {
    references.add('structure-set.frame', uid(frame, 'x00200052'));
    for (const study of items(frame, 'x30060012')) {
      for (const series of items(study, 'x30060014')) {
        references.add('structure-set.series', uid(series, 'x0020000e'));
      }
    }
  }
  // StructureSetROISequence: each ROI names the frame it is defined in.
  for (const roi of items(dataSet, 'x30060020')) {
    references.add('structure-set.frame', uid(roi, 'x30060024'));
  }
}

function registrationReferences(dataSet: DataSet, references: References): void {
  // The frame the registration maps into, then the frames it maps from.
  references.add('registration.frame', uid(dataSet, 'x00200052'));
  for (const registration of items(dataSet, 'x00700308')) {
    references.add('registration.frame', uid(registration, 'x00200052'));
  }
  // DeformableRegistrationSequence: SourceFrameOfReferenceUID
  for (const registration of items(dataSet, 'x00640002')) {
    references.add('registration.frame', uid(registration, 'x00640003'));
  }
  // ReferencedSeriesSequence, here and under the studies the other instances are in.
  const series = [
    ...items(dataSet, 'x00081115'),
    ...items(dataSet, 'x00081200').flatMap((study) => items(study, 'x00081115')),
  ];
  for (const one of series) references.add('registration.series', uid(one, 'x0020000e'));
}

/** The ReferencedSOPInstanceUID of each item of a sequence. */
function referencedInstances(dataSet: DataSet, tag: string): (string | null)[] {
  return items(dataSet, tag).map((item) => uid(item, 'x00081155'));
}

/**
 * Read a Part 10 file's header. The pixel data is not read, so this is cheap
 * for a large image; nothing is decoded and no transfer syntax is refused.
 */
export function readInstanceHeader(bytes: Uint8Array): InstanceHeaderResult {
  let dataSet: DataSet;
  try {
    dataSet = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });
  } catch {
    return { ok: false, reason: 'not-dicom' };
  }
  const sopClassUid = uid(dataSet, 'x00080016') ?? uid(dataSet, 'x00020002');
  const sopInstanceUid = uid(dataSet, 'x00080018') ?? uid(dataSet, 'x00020003');
  const studyUid = uid(dataSet, 'x0020000d');
  const seriesUid = uid(dataSet, 'x0020000e');
  if (!sopClassUid || !sopInstanceUid || !studyUid || !seriesUid) {
    return { ok: false, reason: 'incomplete' };
  }

  const references = new References();
  if (sopClassUid === RT_STRUCTURE_SET) {
    structureSetReferences(dataSet, references);
  } else if (RT_PLANS.has(sopClassUid)) {
    for (const target of referencedInstances(dataSet, 'x300c0060')) {
      references.add('plan.structure-set', target);
    }
  } else if (sopClassUid === RT_DOSE) {
    for (const target of referencedInstances(dataSet, 'x300c0002')) {
      references.add('dose.plan', target);
    }
    for (const target of referencedInstances(dataSet, 'x300c0060')) {
      references.add('dose.structure-set', target);
    }
  } else if (REGISTRATIONS.has(sopClassUid)) {
    registrationReferences(dataSet, references);
  }

  return {
    ok: true,
    header: {
      sopClassUid,
      sopInstanceUid,
      transferSyntaxUid: uid(dataSet, 'x00020010'),
      patient: {
        id: text(dataSet, 'x00100020') ?? '',
        issuer: text(dataSet, 'x00100021') ?? '',
        name: text(dataSet, 'x00100010'),
        birthDate: text(dataSet, 'x00100030'),
        sex: text(dataSet, 'x00100040'),
      },
      study: {
        uid: studyUid,
        date: text(dataSet, 'x00080020'),
        time: text(dataSet, 'x00080030'),
        description: text(dataSet, 'x00081030'),
        accessionNumber: text(dataSet, 'x00080050'),
      },
      series: {
        uid: seriesUid,
        modality: text(dataSet, 'x00080060')?.toUpperCase() ?? 'OT',
        number: integer(dataSet, 'x00200011'),
        description: text(dataSet, 'x0008103e'),
        frameOfReferenceUid: uid(dataSet, 'x00200052'),
      },
      instanceNumber: integer(dataSet, 'x00200013'),
      frames: count(dataSet, 'x00280008'),
      references: references.list,
    },
  };
}
