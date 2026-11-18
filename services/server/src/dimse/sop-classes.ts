/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the DICOM listener agrees to on an association: which kinds of object
// it takes, and in which transfer syntaxes.

/** Verification: C-ECHO. */
export const VERIFICATION = '1.2.840.10008.1.1';

/**
 * The storage SOP classes the listener takes: the images a radiotherapy
 * course is made of, and the radiotherapy objects and registrations the
 * index knows the relationships of. Anything else is refused when the
 * association is made, so the sender knows before it sends.
 */
export const STORAGE_SOP_CLASSES: Readonly<Record<string, string>> = {
  '1.2.840.10008.5.1.4.1.1.2': 'CT Image',
  '1.2.840.10008.5.1.4.1.1.2.1': 'Enhanced CT Image',
  '1.2.840.10008.5.1.4.1.1.4': 'MR Image',
  '1.2.840.10008.5.1.4.1.1.4.1': 'Enhanced MR Image',
  '1.2.840.10008.5.1.4.1.1.128': 'Positron Emission Tomography Image',
  '1.2.840.10008.5.1.4.1.1.130': 'Enhanced PET Image',
  '1.2.840.10008.5.1.4.1.1.20': 'Nuclear Medicine Image',
  '1.2.840.10008.5.1.4.1.1.7': 'Secondary Capture Image',
  '1.2.840.10008.5.1.4.1.1.481.1': 'RT Image',
  '1.2.840.10008.5.1.4.1.1.481.2': 'RT Dose',
  '1.2.840.10008.5.1.4.1.1.481.3': 'RT Structure Set',
  '1.2.840.10008.5.1.4.1.1.481.5': 'RT Plan',
  '1.2.840.10008.5.1.4.1.1.481.8': 'RT Ion Plan',
  '1.2.840.10008.5.1.4.1.1.66.1': 'Spatial Registration',
  '1.2.840.10008.5.1.4.1.1.66.3': 'Deformable Spatial Registration',
};

/**
 * Query and retrieve (#52): C-FIND, C-MOVE and C-GET of the two information
 * models, of which one starts at the patient and the other at the study.
 */
export const QUERY_RETRIEVE_SOP_CLASSES: Readonly<
  Record<string, { readonly root: 'patient' | 'study'; readonly service: 'find' | 'move' | 'get' }>
> = {
  '1.2.840.10008.5.1.4.1.2.1.1': { root: 'patient', service: 'find' },
  '1.2.840.10008.5.1.4.1.2.1.2': { root: 'patient', service: 'move' },
  '1.2.840.10008.5.1.4.1.2.1.3': { root: 'patient', service: 'get' },
  '1.2.840.10008.5.1.4.1.2.2.1': { root: 'study', service: 'find' },
  '1.2.840.10008.5.1.4.1.2.2.2': { root: 'study', service: 'move' },
  '1.2.840.10008.5.1.4.1.2.2.3': { root: 'study', service: 'get' },
};

export const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
export const IMPLICIT_VR_LE = '1.2.840.10008.1.2';

/**
 * The transfer syntaxes the listener takes, the one it would rather have
 * first. An object is kept in the syntax it arrives in: nothing is
 * transcoded. So these are the ones the PACS can read the header of, and
 * the compressed ones are those the viewer decodes.
 */
export const TRANSFER_SYNTAXES: readonly string[] = [
  EXPLICIT_VR_LE,
  IMPLICIT_VR_LE,
  '1.2.840.10008.1.2.5', // RLE Lossless
  '1.2.840.10008.1.2.4.50', // JPEG Baseline
  '1.2.840.10008.1.2.4.57', // JPEG Lossless
  '1.2.840.10008.1.2.4.70', // JPEG Lossless, first-order prediction
  '1.2.840.10008.1.2.4.80', // JPEG-LS Lossless
  '1.2.840.10008.1.2.4.81', // JPEG-LS Near-Lossless
  '1.2.840.10008.1.2.4.90', // JPEG 2000 Lossless
  '1.2.840.10008.1.2.4.91', // JPEG 2000
];

/** The one of the offered transfer syntaxes the listener takes, or null when it takes none. */
export function chooseTransferSyntax(offered: readonly string[]): string | null {
  return TRANSFER_SYNTAXES.find((syntax) => offered.includes(syntax)) ?? null;
}

/**
 * Whether a text can be an AE title (PS3.5, value representation AE): 1 to
 * 16 characters of the default repertoire, no backslash, not only spaces.
 */
export function isAeTitle(text: string): boolean {
  return /^[\x20-\x5b\x5d-\x7e]{1,16}$/.test(text) && text.trim() !== '' && text === text.trim();
}
