/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A ZIP archive of files as they are, not compressed: the one file a browser
// is handed when what was made is many files (the slices of a series). The
// format is PKWARE's APPNOTE, without its 64-bit extension: at most 65 535
// files, and less than 4 GiB in all.

/** A file to put in an archive. Its name is its path in it, with `/` between folders. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

/** An archive cannot be made of what was given: too much, or a name that will not do. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP archive keeps of each file (ISO 3309). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let at = 0; at < bytes.length; at++) crc = CRC_TABLE[(crc ^ bytes[at]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const MOST_FILES = 0xffff;
const MOST_BYTES = 0xffffffff;
/** Names that are the same on every system that may open the archive. */
const NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** A date and time as MS-DOS has them, to two seconds, which is what an archive keeps. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * The parts of an archive holding the files, in order, to make a `Blob` of.
 * The files' bytes are among the parts as they were given, not copied.
 * Throws a {@link ZipError} for more than the format holds without its 64-bit
 * extension, for a name twice, and for a name with anything in it but
 * letters, digits, `.`, `_` and `-` between slashes.
 */
export function zipStored(entries: readonly ZipEntry[], at: Date): ArrayBuffer[] {
  if (entries.length > MOST_FILES) {
    throw new ZipError(
      `An archive holds at most ${MOST_FILES} files; this would be ${entries.length}.`,
    );
  }
  const { time, date } = dosTime(at);
  const seen = new Set<string>();
  const parts: ArrayBuffer[] = [];
  const directory: ArrayBuffer[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    if (!NAME.test(entry.name) || entry.name.split('/').some((part) => /^\.+$/.test(part))) {
      throw new ZipError(`“${entry.name}” cannot be a file’s name in an archive.`);
    }
    if (seen.has(entry.name)) throw new ZipError(`An archive cannot hold “${entry.name}” twice.`);
    seen.add(entry.name);
    const size = entry.bytes.byteLength;
    const crc = crc32(new Uint8Array(entry.bytes));
    const name = Uint8Array.from(entry.name, (letter) => letter.charCodeAt(0));

    // What both headers say of the file: version needed (1.0), no flags,
    // stored, when, its CRC, its size twice (packed and not), its name's length.
    const common = (view: DataView, from: number): void => {
      view.setUint16(from, 10, true);
      view.setUint16(from + 2, 0, true);
      view.setUint16(from + 4, 0, true);
      view.setUint16(from + 6, time, true);
      view.setUint16(from + 8, date, true);
      view.setUint32(from + 10, crc, true);
      view.setUint32(from + 14, size, true);
      view.setUint32(from + 18, size, true);
      view.setUint16(from + 22, name.length, true);
    };

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    common(localView, 4);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 10, true); // made by: version 1.0, MS-DOS attributes
    common(centralView, 6);
    centralView.setUint32(42, offset, true); // where its local header is
    central.set(name, 46);

    parts.push(local.buffer, entry.bytes);
    directory.push(central.buffer);
    offset += local.length + size;
    directorySize += central.length;
    if (offset + directorySize > MOST_BYTES) {
      throw new ZipError('The files are more than one archive holds (4 GiB).');
    }
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return [...parts, ...directory, end.buffer];
}
