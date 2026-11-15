/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Text by its Specific Character Set (#249).
//
// **Reading.** A file says in Specific Character Set (0008,0005) how the
// bytes of its text are to be read. The parser gives every value a byte to
// a character, which is right for the default repertoire and for ISO_IR 100
// (Latin-1) and wrong for the rest: a name in UTF-8 comes out as other
// characters. `readTextByCharacterSet` is called on every file once it is
// parsed, and from then on the file's text is read by what the file says.
//
// **What is decoded.** A file with one character set, of these: the default
// repertoire (none said, or ISO_IR 6); ISO_IR 100; ISO_IR 192 (UTF-8); the
// other single-byte sets of ISO 8859 the platform has a decoder for
// (ISO_IR 101, 109, 110, 144, 127, 126, 138, 148); GB18030 and GBK.
//
// **What is not.** A file that says several sets, which is text with ISO
// 2022 escapes (Japanese and Korean files are written so), and any set not
// listed. Its text is left a byte to a character, as all text was before,
// and `CharacterSetUse.decoded` says `no`: nothing is guessed at.
//
// **Only values with a byte above 127 are touched.** Every set decoded here
// has ASCII as it is, so a UID, a number or a code is read as before
// whatever the file says. A value of several parts is split at its
// backslashes before it is decoded; in GB18030 and GBK a backslash may be
// the second byte of a character, and such a value of several parts is
// split wrongly, as it is by the parser.
//
// **Writing.** What is written here is written in UTF-8 and says so
// (`UTF8_CHARACTER_SET`, `p10-encode.ts`).

import type { DataSet } from 'dicom-parser';

/** The Specific Character Set of what is written here: UTF-8. */
export const UTF8_CHARACTER_SET = 'ISO_IR 192';

/** How a file's text was read. */
export interface CharacterSetUse {
  /** Specific Character Set (0008,0005) as the file has it, its values with `\` between; '' for none. */
  readonly declared: string;
  /**
   * `default`: none said, or one that is a byte to a character, so nothing
   * was to be done. `yes`: decoded by what the file says. `no`: the file
   * says a set that is not decoded, and its text is a byte to a character.
   */
  readonly decoded: 'default' | 'yes' | 'no';
}

/** Bytes to text. */
type Decode = (bytes: Uint8Array) => string;

/** The sets that are a byte to a character as the parser reads them: the default repertoire and Latin-1. */
const AS_READ = new Set(['', 'ISO_IR 6', 'ISO 2022 IR 6', 'ISO_IR 100', 'ISO 2022 IR 100']);

/** The label the platform's decoder goes by, for each set that is decoded. */
const DECODER_LABEL: Readonly<Record<string, string>> = {
  'ISO_IR 192': 'utf-8',
  'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4',
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  GB18030: 'gb18030',
  GBK: 'gbk',
};

/** The values of a Specific Character Set as it is written, in upper case. */
export function characterSetValues(declared: string | null | undefined): string[] {
  return (declared ?? '').split('\\').map((value) => value.trim().toUpperCase());
}

/**
 * How text of a Specific Character Set is decoded: `as-read` when a byte
 * to a character is right, a decoder when there is one, and null for a set
 * that is not decoded (several sets, or one not known here or to the
 * platform).
 */
export function decoderFor(declared: string | null | undefined): Decode | 'as-read' | null {
  const values = characterSetValues(declared);
  if (values.length !== 1) return null;
  if (AS_READ.has(values[0])) return 'as-read';
  const label = DECODER_LABEL[values[0]];
  if (!label) return null;
  try {
    const decoder = new TextDecoder(label);
    return (bytes) => decoder.decode(bytes);
  } catch {
    // The platform has no decoder for it.
    return null;
  }
}

/** Whether a value the parser read has a byte above 127: the only values a character set changes. */
function beyondAscii(value: string): boolean {
  for (let at = 0; at < value.length; at++) if (value.charCodeAt(at) > 0x7f) return true;
  return false;
}

/** A value the parser read, a byte to a character, read again by `decode`. */
export function decodeAsRead(value: string, decode: Decode): string {
  if (!beyondAscii(value)) return value;
  const bytes = new Uint8Array(value.length);
  for (let at = 0; at < value.length; at++) bytes[at] = value.charCodeAt(at) & 0xff;
  return decode(bytes);
}

type Reads = Pick<DataSet, 'string' | 'text'>;

/** Have a data set, and every item under it, give its text by `decode`. */
function decodeWith(dataSet: DataSet, decode: Decode): void {
  const original: Reads = { string: dataSet.string, text: dataSet.text };
  const reads = dataSet as Reads;
  reads.string = function (this: DataSet, tag: string, index?: number) {
    const value = original.string.call(this, tag, index);
    return value === undefined ? value : decodeAsRead(value, decode);
  };
  reads.text = function (this: DataSet, tag: string, index?: number) {
    const value = original.text.call(this, tag, index);
    return value === undefined ? value : decodeAsRead(value, decode);
  };
  for (const element of Object.values(dataSet.elements)) {
    for (const item of element.items ?? []) {
      if (item.dataSet) decodeWith(item.dataSet, decode);
    }
  }
}

/**
 * Read a parsed file's text by its Specific Character Set from now on: its
 * `string` and `text`, and those of every item under it. To be called once,
 * when the file has been parsed. Says how the text is read.
 */
export function readTextByCharacterSet(dataSet: DataSet): CharacterSetUse {
  const declared = characterSetValues(dataSet.string('x00080005')).join('\\');
  const decode = decoderFor(declared);
  if (decode === 'as-read') return { declared, decoded: 'default' };
  if (decode === null) return { declared, decoded: 'no' };
  decodeWith(dataSet, decode);
  return { declared, decoded: 'yes' };
}

/** Text without what prints nothing: a control character becomes `?`. Every other character is kept. */
export const plain = (value: string): string => value.replace(/\p{Cc}/gu, '?');

/**
 * Text as a value of at most `most` characters may hold it: without what
 * prints nothing, and cut at a whole character, not half of one. Written
 * in UTF-8, it keeps every other character it has.
 */
export function writableText(value: string, most: number): string {
  return Array.from(plain(value)).slice(0, most).join('');
}

/** Text as the bytes it is written in: UTF-8. */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
