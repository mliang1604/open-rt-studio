/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the derived objects on screen were made from (#91): for a structure
// set that says it was propagated, and for an image that says it is derived,
// when it was made, from what, through which registration, and what the
// object says of itself in its own words.
//
// Everything here is read from the object. What it names by UID is named by
// what it is called when that is open here too, and by the UID when not.
// The registration is read from the instances an image names as its sources;
// a structure set has no place for one, so there it is read from the words
// this application writes, and left out for words that are not its own.

import {
  formatDicomDate,
  formatDicomTime,
  type RegistrationObject,
  type Series,
  type StructureSet,
} from '@open-rt-studio/dicom';

/** One line of what is known: `From`, and what from. */
export interface ProvenanceRow {
  readonly name: string;
  readonly value: string;
}

/** A derived object on screen and what it was made from. */
export interface ProvenanceItem {
  readonly key: string;
  /** What the object is: `Structure set “PROPAGATED”`. */
  readonly title: string;
  readonly rows: readonly ProvenanceRow[];
  /** What the object says of itself, whole; null when it says nothing in words. */
  readonly says: string | null;
}

export interface ProvenanceOf {
  /** The structure sets drawn on the image on screen. */
  readonly structureSets: readonly StructureSet[];
  /** The image on screen and those laid over it. */
  readonly images: readonly Series[];
  /** Every structure set that is open, whatever it is drawn on: to name a predecessor by. */
  readonly knownSets: readonly StructureSet[];
  /** Every registration object that is open: to name a source by. */
  readonly knownRegistrations: readonly RegistrationObject[];
  /** What a series is called, by its UID; null for one that is not open here. */
  readonly seriesName: (uid: string) => string | null;
}

const NO_REGISTRATION = 'with no registration: the two series share a frame of reference';

/**
 * The part of a description written by this application that says which
 * registrations something was taken through; null for words that do not
 * have it, as another system's would not.
 */
export function throughOf(text: string): string | null {
  if (text.includes(NO_REGISTRATION)) return NO_REGISTRATION;
  const found = /\b(through .*?)\. \d+ (?:of \d+ voxels lie|by moving)/s.exec(text);
  return found ? found[1] : null;
}

const quoted = (name: string | null | undefined): string =>
  name?.trim() ? `“${name.trim()}”` : '';

/** When something was made, to the minute; null when it does not say. */
export function madeAt(
  date: string | null | undefined,
  time: string | null | undefined,
): string | null {
  if (!date || !/^\d{8}$/.test(date)) return null;
  const clock = time && /^\d{4}/.test(time) ? ` ${formatDicomTime(time).slice(0, 5)}` : '';
  return `${formatDicomDate(date)}${clock}`;
}

/** Whether a structure set says it was made from another: a predecessor, or a structure that was resampled. */
export function isDerivedSet(set: StructureSet): boolean {
  return (
    (set.predecessorSopInstanceUids?.length ?? 0) > 0 ||
    set.rois.some((roi) => roi.generation?.resampled)
  );
}

function setItem(set: StructureSet, at: number, of: ProvenanceOf): ProvenanceItem {
  const rows: ProvenanceRow[] = [];
  const made = madeAt(set.date, set.time);
  if (made) rows.push({ name: 'Made', value: made });
  for (const uid of set.predecessorSopInstanceUids ?? []) {
    const known = of.knownSets.find((one) => one.sopInstanceUid === uid);
    const on = known?.referencedSeriesUids.map(of.seriesName).find((name) => name) ?? null;
    rows.push({
      name: 'From',
      value: known
        ? `Structure set ${quoted(known.label) || 'without a label'}${on ? ` on ${on}` : ''}`
        : `Structure set ${uid}, which is not open here`,
    });
  }
  const through = set.description ? throughOf(set.description) : null;
  if (through) rows.push({ name: 'Registration', value: through });
  // How each structure was made, as each says it: the same words counted once.
  const ways = new Map<string, number>();
  for (const roi of set.rois) {
    const way = roi.generation?.description?.trim();
    if (way) ways.set(way, (ways.get(way) ?? 0) + 1);
  }
  for (const [way, count] of ways) {
    rows.push({ name: count === 1 ? '1 structure' : `${count} structures`, value: way });
  }
  return {
    key: `set-${set.sopInstanceUid ?? at}`,
    title: `Structure set ${quoted(set.label) || 'without a label'}`,
    rows,
    says: set.description?.trim() || null,
  };
}

function imageItem(series: Series, of: ProvenanceOf): ProvenanceItem | null {
  const derivation = series.metadata?.derivation;
  if (!derivation) return null;
  const rows: ProvenanceRow[] = [];
  const made = madeAt(derivation.date, derivation.time);
  if (made) rows.push({ name: 'Made', value: made });
  for (const uid of derivation.relatedSeriesUids) {
    const name = of.seriesName(uid);
    rows.push({ name: 'From', value: name ?? `Series ${uid}, which is not open here` });
  }
  for (const uid of derivation.sourceInstanceUids) {
    const known = of.knownRegistrations.find((one) => one.sopInstanceUid === uid);
    const name = quoted(known?.label) || quoted(known?.description);
    rows.push({
      name: 'Registration',
      value: known ? `Registration ${name || uid}` : `Object ${uid}, which is not open here`,
    });
  }
  // A registration made by hand is in no object: the words are all there is of it.
  const through = derivation.description ? throughOf(derivation.description) : null;
  if (through && derivation.sourceInstanceUids.length === 0) {
    rows.push({ name: 'Registration', value: through });
  }
  return {
    key: `image-${series.uid}`,
    title: `Image ${quoted(series.description) || 'without a description'}`,
    rows,
    says: derivation.description,
  };
}

/** The derived objects on screen, images first, each with what it was made from. */
export function provenanceOf(of: ProvenanceOf): ProvenanceItem[] {
  return [
    ...of.images.flatMap((series) => imageItem(series, of) ?? []),
    ...of.structureSets.flatMap((set, at) => (isDerivedSet(set) ? [setItem(set, at, of)] : [])),
  ];
}
