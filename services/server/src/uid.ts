/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The text is not a DICOM UID. */
export class InvalidUidError extends Error {
  override readonly name = 'InvalidUidError';
  constructor() {
    // The text itself is left out: messages end up in logs.
    super('A UID is 1 to 64 characters: numbers separated by single dots.');
  }
}

const UID = /^[0-9]+(\.[0-9]+)*$/;

/**
 * Whether the text has the form of a DICOM UID (PS3.5, 9.1): at most 64
 * characters, numeric components separated by dots. A component with a
 * leading zero is against the standard but is found in real files, and is
 * accepted.
 */
export function isUid(text: string): boolean {
  return typeof text === 'string' && text.length <= 64 && UID.test(text);
}

/** Throws {@link InvalidUidError} for anything that is not a UID. */
export function assertUid(text: string): void {
  if (!isUid(text)) throw new InvalidUidError();
}
