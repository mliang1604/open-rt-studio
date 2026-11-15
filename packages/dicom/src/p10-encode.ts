/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Writing DICOM: the Explicit VR Little Endian element and sequence encoding,
// and the Part 10 file around a data set. `dicom-parser` only reads, so the
// objects this application writes (structure sets, registrations) are put
// together with these. Not exported from the package.

/** Manufacturer (0008,0070) written into every object this writer produces. */
export const MANUFACTURER = 'Open RT Studio';

const two = (n: number): string => String(n).padStart(2, '0');

/** A date as DICOM DA (`YYYYMMDD`), in local time. */
export function dicomDate(date: Date): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
}

/** A time as DICOM TM (`HHMMSS`), in local time. */
export function dicomTime(date: Date): string {
  return `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** Explicit VR Little Endian — the transfer syntax this writer emits. */
export const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';

/** VRs that use the 2-reserved-byte + 4-byte-length header form. */
export const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

/** Assemble a full P10 file: preamble + DICM + file meta group + data set. */
export function p10File(
  dataSet: Uint8Array,
  sopClassUid: string,
  sopInstanceUid: string,
): ArrayBuffer {
  const metaBody = concat([
    element(0x0002, 0x0002, 'UI', uid(sopClassUid)), // MediaStorageSOPClassUID
    element(0x0002, 0x0003, 'UI', uid(sopInstanceUid)), // MediaStorageSOPInstanceUID
    element(0x0002, 0x0010, 'UI', uid(EXPLICIT_VR_LE)), // TransferSyntaxUID
  ]);
  const groupLength = element(0x0002, 0x0000, 'UL', u32le(metaBody.length));
  const file = concat([
    new Uint8Array(128), // preamble
    ascii('DICM'),
    groupLength,
    metaBody,
    dataSet,
  ]);
  return file.buffer.slice(0, file.length) as ArrayBuffer;
}

/** Encode one Explicit-VR-LE data element. */
export function element(group: number, el: number, vr: string, value: Uint8Array): Uint8Array {
  const header = new Uint8Array(LONG_VRS.has(vr) ? 12 : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  header[4] = vr.charCodeAt(0);
  header[5] = vr.charCodeAt(1);
  if (LONG_VRS.has(vr)) {
    view.setUint32(8, value.length, true); // bytes 6-7 reserved, left zero
  } else {
    view.setUint16(6, value.length, true);
  }
  return concat([header, value]);
}

/** Wrap item data sets into an SQ element with explicit (defined) lengths. */
export function sequence(group: number, el: number, itemBodies: Uint8Array[]): Uint8Array {
  const body = concat(
    itemBodies.map((item) => {
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint16(0, 0xfffe, true); // Item tag (FFFE,E000)
      view.setUint16(2, 0xe000, true);
      view.setUint32(4, item.length, true);
      return concat([header, item]);
    }),
  );
  return element(group, el, 'SQ', body);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pad to even length (every DICOM value): text VRs with a space, UIDs with a null. */
export function padEven(bytes: Uint8Array, padByte: number): Uint8Array {
  return bytes.length % 2 === 0 ? bytes : concat([bytes, Uint8Array.of(padByte)]);
}

export function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A text value (SH/LO/CS/PN…), space-padded to even length. */
export function text(s: string): Uint8Array {
  return padEven(ascii(s), 0x20);
}

/** A UID value, null-padded to even length. */
export function uid(s: string): Uint8Array {
  return padEven(ascii(s), 0x00);
}

/** An Integer String (IS) value: backslash-separated integers, space-padded. */
export function integers(values: readonly number[]): Uint8Array {
  return text(values.map((v) => String(Math.round(v))).join('\\'));
}

/** A Decimal String (DS) value: backslash-separated decimals, space-padded. */
export function decimals(values: readonly number[]): Uint8Array {
  return text(values.map(formatDs).join('\\'));
}

/**
 * Format a number as a DICOM Decimal String (DS): plain decimal, no exponent,
 * at most 16 characters. Integers stay integral; fractions are written with
 * enough precision for sub-millimetre contour points and trailing zeros are
 * trimmed.
 */
export function formatDs(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let s = n.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s.length <= 16) return s;
  // Very large magnitudes: fall back to fewer fractional digits to fit 16 chars.
  const intDigits = Math.trunc(Math.abs(n)).toString().length + (n < 0 ? 1 : 0);
  return n.toFixed(Math.max(0, 15 - intDigits));
}

/**
 * A length or a direction as a Decimal String with as many places as its
 * sixteen characters hold. A place in the patient is a slice's position plus
 * steps of the spacing, so what is rounded away here is multiplied by the
 * image's width in voxels when the series is read again.
 */
export function precise(value: number): string {
  if (!Number.isFinite(value)) return '0';
  for (let places = 13; places >= 0; places--) {
    const fixed = value
      .toFixed(places)
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
    if (fixed.length <= 16) return fixed === '-0' ? '0' : fixed;
  }
  return formatDs(value);
}
export const preciseDs = (values: readonly number[]): Uint8Array =>
  text(values.map(precise).join('\\'));

/** An unsigned 16-bit value (US). */
export function us(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

/** Text as plain ASCII: a character outside it, or one that prints nothing, becomes `?`. */
export const plain = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?');

/** A coded entry: the Code Sequence Macro's three required elements. */
export const code = (value: string, scheme: string, meaning: string): Uint8Array =>
  concat([
    element(0x0008, 0x0100, 'SH', text(value)), // CodeValue
    element(0x0008, 0x0102, 'SH', text(scheme)), // CodingSchemeDesignator
    element(0x0008, 0x0104, 'LO', text(meaning)), // CodeMeaning
  ]);

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/**
 * Generate a fresh DICOM UID under the standard `2.25` (UUID-derived) root: a
 * run of random decimal digits, kept within the 64-character UID limit. Used for
 * the new object's SOP Instance UID when the caller supplies none.
 */
export function generateUid(): string {
  let digits = '';
  while (digits.length < 30) digits += Math.floor(Math.random() * 1e9).toString();
  // No leading zero after the root, and stay under 64 chars.
  return `2.25.${digits.slice(0, 30).replace(/^0+/, '') || '0'}`;
}
