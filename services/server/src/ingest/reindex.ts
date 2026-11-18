/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Making an index again from what the store holds (#328): for an index that
// was lost, and for a server that is given another database to keep its
// index in. Each instance is read as ingest reads it and filed as ingest
// files it, so the index that comes of it is the one ingesting the same
// files gives.

import { readInstanceHeader } from '@open-rt-studio/dicom';

import { SILENT_LOGGER, type Logger } from '../logger.js';
import { InvalidEntryError } from '../pacs-index/entries.js';
import { IndexConflictError, type PacsIndex } from '../pacs-index/pacs-index.js';
import { InstanceNotFoundError, type DicomStore } from '../store/dicom-store.js';
import { indexEntry } from './ingest.js';

/** What came of filling an index: how many instances of the store went which way. */
export interface FillSummary {
  /** The instances the store listed. */
  readonly instances: number;
  /** Filed, and not in the index before. */
  readonly added: number;
  /** Filed, over what the index had of them. */
  readonly updated: number;
  /** Not filed: the bytes are not a DICOM object that can be filed, or say they are another instance. */
  readonly unreadable: number;
  /** Not filed: the index has the instance, its series or its study somewhere else. */
  readonly conflicts: number;
  /** Listed, and removed from the store before they were read. */
  readonly gone: number;
}

export interface FillOptions {
  readonly store: DicomStore;
  readonly index: PacsIndex;
  readonly logger?: Logger;
  /** Told after each instance, with the summary so far. */
  readonly onProgress?: (soFar: FillSummary) => void;
}

/** Whether every instance the store listed is in the index now. */
export const filledWhole = (summary: FillSummary): boolean =>
  summary.unreadable === 0 && summary.conflicts === 0;

/**
 * File every instance the store holds in the index. What the index has
 * already is brought up to date, and nothing is taken out of it: an instance
 * it lists that the store no longer holds stays listed.
 *
 * An instance that cannot be filed is counted and passed over; the rest are
 * filed. Rejects, with what was filed so far left in the index, when the
 * store cannot be read or the index's database fails.
 */
export async function fillIndex({
  store,
  index,
  logger = SILENT_LOGGER,
  onProgress,
}: FillOptions): Promise<FillSummary> {
  const summary = { instances: 0, added: 0, updated: 0, unreadable: 0, conflicts: 0, gone: 0 };
  for await (const stored of store.list()) {
    summary.instances += 1;
    let bytes: Uint8Array;
    try {
      const pieces: Uint8Array[] = [];
      for await (const piece of await store.get(stored.sopInstanceUid)) {
        pieces.push(piece as Uint8Array);
      }
      bytes = Buffer.concat(pieces);
    } catch (error) {
      if (!(error instanceof InstanceNotFoundError)) throw error;
      summary.gone += 1;
      onProgress?.({ ...summary });
      continue;
    }
    const read = readInstanceHeader(bytes);
    // The store keeps an instance under the UID its bytes carry. Bytes that
    // say otherwise are not what was stored there.
    if (!read.ok || read.header.sopInstanceUid !== stored.sopInstanceUid) {
      summary.unreadable += 1;
    } else {
      try {
        const outcome = await index.putInstance(indexEntry(read.header, stored));
        summary[outcome] += 1;
      } catch (error) {
        if (error instanceof IndexConflictError) summary.conflicts += 1;
        else if (error instanceof InvalidEntryError) summary.unreadable += 1;
        else throw error;
      }
    }
    onProgress?.({ ...summary });
  }
  // Counts only: which instances, and whose, is not for the log.
  logger.info('index-filled', { ...summary });
  return summary;
}

/** What came of bringing patients' timepoints from one index into another. */
export interface TimepointsCopied {
  /** The patients that had timepoints in the index they were read from. */
  readonly patients: number;
  /** Of those, the patients whose timepoints are in the other index now. */
  readonly copied: number;
  /** Of those, the patients that have timepoints in the other index already, which were left as they are. */
  readonly alreadyThere: number;
  /** Of those, the patients the other index does not have. */
  readonly withoutPatient: number;
  /** The studies that were left out of a timepoint: the other index does not have them under that patient. */
  readonly studiesLeftOut: number;
}

const PAGE = 200;

/**
 * Bring the timepoints users made from one index into another. They are in
 * no file, so filling an index from the store does not bring them.
 *
 * A patient is the same in both when a study of theirs is: the two indexes
 * number their patients each in its own way. Timepoints are brought to a
 * patient that has none where they are written, and only to such a patient:
 * what someone has made there since is never replaced, so this can be done
 * again.
 */
export async function copyTimepoints(from: PacsIndex, to: PacsIndex): Promise<TimepointsCopied> {
  const summary = { patients: 0, copied: 0, alreadyThere: 0, withoutPatient: 0, studiesLeftOut: 0 };
  for (let offset = 0; ; offset += PAGE) {
    const patients = await from.findPatients({ limit: PAGE, offset });
    for (const patient of patients) {
      const timepoints = (await from.getTimepoints(patient.patientKey)) ?? [];
      if (timepoints.length === 0) continue;
      summary.patients += 1;
      // Whose they are there: the patient of the first of this patient's studies it has.
      let there: number | null = null;
      for (const study of await from.findStudies({ patientKey: patient.patientKey })) {
        const same = await to.getStudy(study.studyInstanceUid);
        if (same) {
          there = same.patientKey;
          break;
        }
      }
      if (there === null) {
        summary.withoutPatient += 1;
        continue;
      }
      if (((await to.getTimepoints(there)) ?? []).length > 0) {
        summary.alreadyThere += 1;
        continue;
      }
      const theirs = new Set(
        (await to.findStudies({ patientKey: there })).map((study) => study.studyInstanceUid),
      );
      const kept = timepoints.map((timepoint) => ({
        ...timepoint,
        studyUids: timepoint.studyUids.filter((uid) => theirs.has(uid)),
      }));
      summary.studiesLeftOut += timepoints.reduce(
        (sum, timepoint, at) => sum + timepoint.studyUids.length - kept[at].studyUids.length,
        0,
      );
      if (await to.putTimepoints(there, kept)) summary.copied += 1;
      else summary.withoutPatient += 1;
    }
    if (patients.length < PAGE) return summary;
  }
}
