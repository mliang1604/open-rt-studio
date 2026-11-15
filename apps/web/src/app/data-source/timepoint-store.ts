/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable } from '@angular/core';

import { readTimepoints, type Timepoint } from './timepoints';

const PREFIX = 'open-rt-studio.timepoints.v1.';

/**
 * The timepoints of patients whose files were opened, kept in this browser
 * (#39). There is no server to keep them, and the files are not written to.
 *
 * What is kept: the names that were typed and the Study Instance UIDs under
 * them, under a SHA-256 digest of the Patient ID. No patient name and no
 * Patient ID is kept, and a patient without an ID has nothing kept: there
 * is nothing to know them by the next time.
 */
@Injectable({ providedIn: 'root' })
export class TimepointStore {
  /** What is kept for a patient; nothing when nothing is, or when it cannot be read. */
  async read(patientId: string): Promise<Timepoint[]> {
    const key = await keyOf(patientId);
    if (!key) return [];
    try {
      return readTimepoints(JSON.parse(localStorage.getItem(key) ?? 'null')) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Keep a patient's timepoints, or nothing of the patient when there are
   * none. Rejects when the browser keeps nothing, so that it can be said.
   */
  async write(patientId: string, timepoints: readonly Timepoint[]): Promise<void> {
    const key = await keyOf(patientId);
    if (!key) throw new Error('A patient without a Patient ID cannot be known again.');
    if (timepoints.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(timepoints));
  }
}

/** The key a patient's timepoints are kept under; null for a patient without an ID. */
export async function keyOf(patientId: string): Promise<string | null> {
  if (patientId.trim() === '') return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(patientId));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return PREFIX + hex.join('');
}
