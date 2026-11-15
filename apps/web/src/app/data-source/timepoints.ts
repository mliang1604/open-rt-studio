/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Timepoints (#39): a patient's studies grouped under names a user gives,
// such as "Planning" or "Fraction 10", for the work that goes from one
// point of a course to another.
//
// What is kept is small: the named timepoints in the user's order, each with
// the studies assigned to it. A study assigned to none is grouped with the
// other unassigned studies of its date, under that date, so that a patient
// nobody has grouped is grouped by study date, and a study that arrives
// later is shown without anyone having to place it.

import { formatDicomDate } from '@open-rt-studio/dicom';

/** A timepoint as it is kept: a name, and the studies assigned to it. */
export interface Timepoint {
  /** Its own, and of no meaning: what it is told apart by when it is renamed. */
  readonly id: string;
  readonly name: string;
  /** Study Instance UIDs. A study is in one timepoint at most. */
  readonly studyUids: readonly string[];
}

/** No more timepoints than this are kept for a patient. */
export const MAX_TIMEPOINTS = 100;
/** No longer a name than this. */
export const MAX_TIMEPOINT_NAME = 64;
/** No more studies than this in all of a patient's timepoints. */
export const MAX_TIMEPOINT_STUDIES = 2000;

/** What the grouping needs of a study. */
export interface GroupedStudy {
  readonly studyUid: string;
  /** Study Date as DICOM writes it (`YYYYMMDD`), or null. */
  readonly date: string | null;
}

/** A group of studies as the timeline shows it. */
export interface TimepointGroup<S extends GroupedStudy> {
  /** The timepoint's id, or `date:YYYYMMDD` (`date:` for no date) for a group by date. */
  readonly id: string;
  readonly name: string;
  /** Whether nobody made it: the studies of one date that are in no timepoint. */
  readonly automatic: boolean;
  /** In the order they were given: oldest first. May be empty for a timepoint that was made. */
  readonly studies: readonly S[];
}

/**
 * The studies as groups: the timepoints that were made, in their order, and
 * after them the studies in none, by date, oldest first and undated last.
 */
export function groupStudies<S extends GroupedStudy>(
  studies: readonly S[],
  timepoints: readonly Timepoint[],
): TimepointGroup<S>[] {
  const placed = new Map<string, string>();
  for (const timepoint of timepoints) {
    for (const uid of timepoint.studyUids) if (!placed.has(uid)) placed.set(uid, timepoint.id);
  }
  const made = timepoints.map((timepoint) => ({
    id: timepoint.id,
    name: timepoint.name,
    automatic: false,
    studies: studies.filter((study) => placed.get(study.studyUid) === timepoint.id),
  }));
  const byDate = new Map<string, S[]>();
  for (const study of studies) {
    if (placed.has(study.studyUid)) continue;
    const date = study.date ?? '';
    byDate.set(date, [...(byDate.get(date) ?? []), study]);
  }
  const dates = [...byDate.keys()].sort((a, b) =>
    a === '' || b === '' ? Number(a === '') - Number(b === '') : a.localeCompare(b),
  );
  return [
    ...made,
    ...dates.map((date) => ({
      id: `date:${date}`,
      name: date ? formatDicomDate(date) : 'No date',
      automatic: true,
      studies: byDate.get(date)!,
    })),
  ];
}

/** A name as it is kept: trimmed, of one line, and no longer than is allowed. */
export function timepointName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_TIMEPOINT_NAME);
}

/** A new timepoint at the end, with the studies given. They leave the timepoints they were in. */
export function addTimepoint(
  timepoints: readonly Timepoint[],
  id: string,
  name: string,
  studyUids: readonly string[] = [],
): Timepoint[] {
  const taken = new Set(studyUids);
  return [
    ...timepoints.map((one) => ({
      ...one,
      studyUids: one.studyUids.filter((uid) => !taken.has(uid)),
    })),
    { id, name: timepointName(name), studyUids: [...taken] },
  ];
}

export function renameTimepoint(
  timepoints: readonly Timepoint[],
  id: string,
  name: string,
): Timepoint[] {
  return timepoints.map((one) => (one.id === id ? { ...one, name: timepointName(name) } : one));
}

/** Move a timepoint one place earlier (`-1`) or later (`1`); the ends stay where they are. */
export function moveTimepoint(
  timepoints: readonly Timepoint[],
  id: string,
  by: -1 | 1,
): Timepoint[] {
  const at = timepoints.findIndex((one) => one.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= timepoints.length) return [...timepoints];
  const next = [...timepoints];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** Remove a timepoint. Its studies are in none then, and are grouped by date again. */
export function removeTimepoint(timepoints: readonly Timepoint[], id: string): Timepoint[] {
  return timepoints.filter((one) => one.id !== id);
}

/** Put a study in a timepoint, and out of any other; `null` takes it out of all. */
export function assignStudy(
  timepoints: readonly Timepoint[],
  studyUid: string,
  id: string | null,
): Timepoint[] {
  return timepoints.map((one) => {
    const without = one.studyUids.filter((uid) => uid !== studyUid);
    return { ...one, studyUids: one.id === id ? [...without, studyUid] : without };
  });
}

/** The timepoint a study is assigned to, or null. */
export function timepointOf(timepoints: readonly Timepoint[], studyUid: string): string | null {
  return timepoints.find((one) => one.studyUids.includes(studyUid))?.id ?? null;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const UID = /^[0-9]+(\.[0-9]+)*$/;

/**
 * What was kept, read back: the timepoints of it that are well formed, or
 * null for what is no list at all. What is kept is outside the program's
 * hands (a browser's storage, a server's answer), so nothing of it is
 * trusted: a study is in the first timepoint that names it, a name is cut
 * to what a name may be, and what is too much is left off.
 */
export function readTimepoints(value: unknown): Timepoint[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const placed = new Set<string>();
  const timepoints: Timepoint[] = [];
  for (const one of value as unknown[]) {
    if (timepoints.length >= MAX_TIMEPOINTS) break;
    if (typeof one !== 'object' || one === null) continue;
    const { id, name, studyUids } = one as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) continue;
    if (typeof name !== 'string') continue;
    const uids: string[] = [];
    for (const uid of Array.isArray(studyUids) ? (studyUids as unknown[]) : []) {
      if (placed.size >= MAX_TIMEPOINT_STUDIES) break;
      if (typeof uid !== 'string' || uid.length > 64 || !UID.test(uid) || placed.has(uid)) continue;
      placed.add(uid);
      uids.push(uid);
    }
    ids.add(id);
    timepoints.push({ id, name: timepointName(name), studyUids: uids });
  }
  return timepoints;
}
