/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DicomMetadata } from './metadata.js';
import { doseOfNames, type DoseInfo, type DoseOf } from './rt-dose.js';
import { orderSlicesThroughPlane } from './slice-order.js';
import type { Slice } from './types.js';

// **A series that holds several doses (#257).** The viewer's unit is the
// series: one series, one volume. An RT Dose object is a grid of its own,
// and a series may hold several: a plan's dose beside a dose to each of its
// beams. Such a series is given here as several, one to a dose object, so
// that no two objects are ever stacked, shown or summed as one grid.
//
// Each of them goes by a key in place of the series' UID: the series' UID
// and the object's SOP Instance UID with a mark between (`seriesKeyParts`).
// A series of one dose object, like any other series, goes by its UID
// alone, as it always has. Whatever writes or asks for a series by its
// DICOM identity takes the UID out of the key first
// (`seriesInstanceUidOf`).

/** Between a series' UID and a dose object's, in the key of one dose of several. No UID holds it. */
const DOSE_OBJECT_MARK = '@';

/** The key of one dose object of a series that holds several. */
export function doseObjectSeriesKey(seriesInstanceUid: string, sopInstanceUid: string): string {
  return `${seriesInstanceUid}${DOSE_OBJECT_MARK}${sopInstanceUid}`;
}

/**
 * What a series' key is of: the series' own UID, and, for one dose object
 * of a series that holds several, that object's SOP Instance UID.
 */
export function seriesKeyParts(key: string): {
  readonly seriesInstanceUid: string;
  readonly doseObjectUid: string | null;
} {
  const at = key.indexOf(DOSE_OBJECT_MARK);
  return at < 0
    ? { seriesInstanceUid: key, doseObjectUid: null }
    : { seriesInstanceUid: key.slice(0, at), doseObjectUid: key.slice(at + 1) || null };
}

/** The SeriesInstanceUID of the series a key is of: the key itself, for all but a dose of several. */
export function seriesInstanceUidOf(key: string): string {
  return seriesKeyParts(key).seriesInstanceUid;
}

/**
 * One DICOM series: a set of slices sharing a SeriesInstanceUID, with the
 * descriptive fields a picker needs plus the slices themselves (so a selected
 * series can be assembled into a {@link Volume} without re-reading files).
 */
export interface Series {
  /**
   * What the series goes by: its SeriesInstanceUID (the empty string for
   * slices that carry no UID), or, for one dose object of a series that
   * holds several, a key of that UID and the object's
   * ({@link doseObjectSeriesKey}).
   */
  readonly uid: string;
  /** SeriesNumber, used to order the picker; null when absent. */
  readonly seriesNumber: number | null;
  /**
   * SeriesDescription for the label; null when absent. One dose object of
   * a series that holds several has what it is the dose of after it, in
   * brackets: `Plan dose (beam 2)`.
   */
  readonly description: string | null;
  /**
   * For one dose object of a series that holds several: what it says it is
   * the dose of, as it is told from the others (`beam 2`,
   * `dose 3 of 3`). Left out for every other series.
   */
  readonly doseOf?: string;
  /** Modality of the series (taken from its first slice); null when absent. */
  readonly modality: string | null;
  /**
   * StudyInstanceUID shared by the series' slices (taken from its first slice);
   * null when absent. {@link import('./catalog').groupStudies} groups series by
   * this into a {@link import('./catalog').StudyRecord}.
   */
  readonly studyUid: string | null;
  /** StudyDate (raw DICOM `DA`, `YYYYMMDD`) of the first slice; null when absent. */
  readonly studyDate: string | null;
  /** StudyTime (raw DICOM `TM`) of the first slice; null when absent. */
  readonly studyTime: string | null;
  /** StudyDescription of the first slice, labelling the study; null when absent. */
  readonly studyDescription: string | null;
  /**
   * PatientID of the first slice; null when absent.
   * {@link import('./catalog').groupPatients} groups series by this.
   */
  readonly patientId: string | null;
  /** PatientName (raw DICOM `PN`) of the first slice; null when absent. */
  readonly patientName: string | null;
  /**
   * FrameOfReferenceUID shared by the series' slices (taken from its first
   * slice); null when absent. An RTSTRUCT is associated to this series by
   * matching its referenced frame of reference against this value.
   */
  readonly frameOfReferenceUid: string | null;
  /** Number of image slices in the series. */
  readonly imageCount: number;
  /** Representative in-plane dimensions [columns, rows] of the first slice. */
  readonly dims: readonly [number, number];
  /** Captured DICOM metadata of the first slice, for the info panel; null if absent. */
  readonly metadata: DicomMetadata | null;
  /** The slices, in the order encountered; {@link buildVolume} re-sorts them. */
  readonly slices: Slice[];
}

/**
 * Group a flat list of parsed slices into series by SeriesInstanceUID.
 *
 * A folder usually holds several series (different acquisitions, orientations,
 * or reconstructions) that cannot share one volume; this splits them so each
 * can be built and viewed on its own. Slices without a UID fall into a single
 * unnamed group. Series are ordered by SeriesNumber ascending (those without a
 * number sort last), tie-broken by UID, so the picker reads in acquisition order.
 *
 * A series that holds several dose objects is given as one series to each
 * object, the plan's dose first and the rest in the order of what they are
 * of.
 */
export function groupSeries(slices: readonly Slice[]): Series[] {
  const byUid = new Map<string, Slice[]>();
  for (const slice of slices) {
    const uid = slice.seriesUid ?? '';
    const group = byUid.get(uid);
    if (group) group.push(slice);
    else byUid.set(uid, [slice]);
  }

  const series: Series[] = [];
  for (const [seriesUid, slicesOfSeries] of byUid) {
    for (const { uid, group, said } of doseObjectsOf(seriesUid, slicesOfSeries)) {
      series.push(seriesOf(uid, group, said));
    }
  }
  return series.sort(compareSeries);
}

/** One series of slices: what a picker shows of it, from its first slice. */
function seriesOf(uid: string, group: Slice[], said: string | null): Series {
  const first = group[0];
  return {
    uid,
    seriesNumber: first.seriesNumber,
    description:
      said === null
        ? first.seriesDescription
        : doseObjectDescription(first.seriesDescription, said),
    modality: first.modality,
    studyUid: first.studyUid,
    studyDate: first.studyDate,
    studyTime: first.studyTime,
    studyDescription: first.studyDescription,
    patientId: first.patientId,
    patientName: first.patientName,
    frameOfReferenceUid: first.frameOfReferenceUid,
    imageCount: group.length,
    dims: [first.columns, first.rows],
    metadata: first.metadata ?? null,
    slices: group,
    ...(said === null ? {} : { doseOf: said }),
  };
}

/** A dose object of a series, as far as telling it from the others of the series needs. */
export interface DoseObjectOf {
  readonly sopInstanceUid: string;
  /** What it says it is the dose of; null where that is not known. */
  readonly of: DoseOf | null;
}

const NOTHING_SAID: DoseOf = { summationType: null, beams: [], fractionGroup: null };

/** Where a dose stands among the doses of its series: the plan's first, then by fraction group and beam. */
function doseRank(of: DoseOf): number[] {
  return [of.summationType === 'PLAN' ? 0 : 1, of.fractionGroup ?? 0, of.beams[0] ?? 0];
}

/**
 * The dose objects of one series in the order they are listed in, each
 * with what it is called among them: the plan's dose first, then by
 * fraction group and beam, then by SOP Instance UID; `whole plan`,
 * `beam 2`, and `dose 3 of 3` for one that does not say. Opened files and
 * a server's listing go by this one order and these names.
 */
export function nameDoseObjects<T extends DoseObjectOf>(
  objects: readonly T[],
): { readonly object: T; readonly said: string }[] {
  const ordered = [...objects].sort((a, b) => {
    const [ra, rb] = [doseRank(a.of ?? NOTHING_SAID), doseRank(b.of ?? NOTHING_SAID)];
    for (let at = 0; at < ra.length; at++) if (ra[at] !== rb[at]) return ra[at] - rb[at];
    return a.sopInstanceUid < b.sopInstanceUid ? -1 : a.sopInstanceUid > b.sopInstanceUid ? 1 : 0;
  });
  const names = doseOfNames(ordered.map((one) => one.of ?? NOTHING_SAID));
  return ordered.map((object, index) => ({ object, said: names[index] }));
}

/** What one dose object of a series of several is called: the series' description, and what it is the dose of. */
export function doseObjectDescription(seriesDescription: string | null, said: string): string {
  return `${seriesDescription ?? 'Dose'} (${said})`;
}

/**
 * The slices of one series as the series the viewer shows: all of them as
 * one, unless they are of several dose objects. Then one to each object,
 * with its key and what it says it is the dose of.
 *
 * A dose object with no SOP Instance UID has nothing to be told from the
 * others by, so a series that holds one is left whole; it is refused when
 * it is opened, as a series of several doses always was.
 */
function doseObjectsOf(
  seriesUid: string,
  slices: Slice[],
): { uid: string; group: Slice[]; said: string | null }[] {
  const whole = [{ uid: seriesUid, group: slices, said: null }];
  const byDose = new Map<DoseInfo, Slice[]>();
  for (const slice of slices) {
    if (!slice.dose) return whole;
    const group = byDose.get(slice.dose);
    if (group) group.push(slice);
    else byDose.set(slice.dose, [slice]);
  }
  if (byDose.size < 2) return whole;
  const uids = [...byDose.keys()].map((dose) => dose.sopInstanceUid);
  if (uids.some((uid) => !uid) || new Set(uids).size !== uids.length) return whole;
  return nameDoseObjects(
    [...byDose.keys()].map((dose) => ({
      sopInstanceUid: dose.sopInstanceUid!,
      of: {
        summationType: dose.summationType,
        beams: dose.beams ?? [],
        fractionGroup: dose.fractionGroup ?? null,
      },
      dose,
    })),
  ).map(({ object, said }) => ({
    uid: doseObjectSeriesKey(seriesUid, object.sopInstanceUid),
    group: byDose.get(object.dose)!,
    said,
  }));
}

/**
 * The series to show first: the one with the most images (the primary
 * acquisition in a typical mixed folder), tie-broken by the picker order so the
 * choice is deterministic. Throws nothing; callers guarantee a non-empty list.
 */
export function largestSeries(series: readonly Series[]): Series {
  return series.reduce((best, s) =>
    s.imageCount > best.imageCount ||
    (s.imageCount === best.imageCount && compareSeries(s, best) < 0)
      ? s
      : best,
  );
}

/**
 * The middle slice of a series: its spatially central image, the natural
 * representative for a preview thumbnail. Slices are ordered along the
 * through-plane axis by ImagePositionPatient projected onto the slice normal
 * when spatial metadata is present, falling back to InstanceNumber — the same
 * ordering {@link import('./volume').buildVolume} uses — and the central one is
 * returned. Returns null for a series with no slices. The series' own array is
 * left untouched (the ordering is done on a copy).
 */
export function middleSlice(series: Series): Slice | null {
  const { slices } = series;
  if (slices.length === 0) return null;
  const ordered = orderSlicesThroughPlane(slices);
  return ordered[Math.floor(ordered.length / 2)];
}

/**
 * Order series by SeriesNumber (absent last), then by UID for stability.
 * The doses of one series stay in the order they were given in.
 */
function compareSeries(a: Series, b: Series): number {
  const an = a.seriesNumber ?? Infinity;
  const bn = b.seriesNumber ?? Infinity;
  if (an !== bn) return an - bn;
  const [au, bu] = [seriesInstanceUidOf(a.uid), seriesInstanceUidOf(b.uid)];
  return au < bu ? -1 : au > bu ? 1 : 0;
}
