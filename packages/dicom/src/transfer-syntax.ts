/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Names of transfer syntaxes this package cannot decode, so a message about a
 * skipped file can say what the file is and not only quote a UID. The ones it
 * can decode never need a name here.
 */
const UNSUPPORTED_NAMES: Readonly<Record<string, string>> = {
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.92': 'JPEG 2000 Multi-component',
  '1.2.840.10008.1.2.4.93': 'JPEG 2000 Multi-component',
  '1.2.840.10008.1.2.4.100': 'MPEG-2 video',
  '1.2.840.10008.1.2.4.101': 'MPEG-2 video',
  '1.2.840.10008.1.2.4.102': 'MPEG-4 video',
  '1.2.840.10008.1.2.4.103': 'MPEG-4 video',
  '1.2.840.10008.1.2.4.107': 'HEVC video',
  '1.2.840.10008.1.2.4.108': 'HEVC video',
  '1.2.840.10008.1.2.4.110': 'JPEG XL',
  '1.2.840.10008.1.2.4.111': 'JPEG XL',
  '1.2.840.10008.1.2.4.112': 'JPEG XL',
  '1.2.840.10008.1.2.4.201': 'High-Throughput JPEG 2000',
  '1.2.840.10008.1.2.4.202': 'High-Throughput JPEG 2000',
  '1.2.840.10008.1.2.4.203': 'High-Throughput JPEG 2000',
};

/** JPEG Baseline and Extended: the DCT-based syntaxes libjpeg-turbo decodes. */
const DCT_JPEG = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);

/** Whether a transfer syntax is DCT-based JPEG (Baseline or Extended). */
export function isDctJpegSyntax(transferSyntax: string): boolean {
  return DCT_JPEG.has(transferSyntax);
}

/**
 * A transfer syntax UID with its name when it is a known one this package
 * cannot decode: `1.2.840.10008.1.2.4.70, JPEG Lossless`. Otherwise the UID.
 */
export function describeTransferSyntax(transferSyntax: string): string {
  const name = UNSUPPORTED_NAMES[transferSyntax];
  return name ? `${transferSyntax}, ${name}` : transferSyntax;
}
