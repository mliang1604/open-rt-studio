/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ZipError, crc32, zipStored, type ZipEntry } from './zip';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const AT = new Date(2026, 10, 14, 9, 5, 7);

/** An archive as one run of bytes. */
function joined(parts: readonly ArrayBuffer[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return out;
}

/** Read an archive the way a program that opens one does: from its end. */
function readBack(archive: Uint8Array): { name: string; text: string; crc: number }[] {
  const view = new DataView(archive.buffer);
  const end = archive.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  expect(at + view.getUint32(end + 12, true)).toBe(end);
  const files: { name: string; text: string; crc: number }[] = [];
  const decode = (from: number, length: number) =>
    new TextDecoder().decode(archive.subarray(from, from + length));
  for (let entry = 0; entry < count; entry++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decode(at + 46, nameLength);
    expect(method).toBe(0);
    expect(view.getUint32(at + 20, true)).toBe(size);
    // The header before the file itself says the same.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 18, true)).toBe(size);
    expect(decode(local + 30, view.getUint16(local + 26, true))).toBe(name);
    expect(view.getUint16(local + 28, true)).toBe(0);
    files.push({ name, text: decode(local + 30 + nameLength, size), crc });
    at += 46 + nameLength;
  }
  expect(at).toBe(end);
  return files;
}

describe('a ZIP archive of files as they are', () => {
  it('keeps the CRC-32 that every program checks a file by', () => {
    // The check value of the CRC's definition.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('holds each file whole, by its name, in the order given', () => {
    const entries: ZipEntry[] = [
      { name: 'series/IM0001.dcm', bytes: bytesOf('first') },
      { name: 'series/IM0002.dcm', bytes: bytesOf('the second one') },
      { name: 'series/empty', bytes: new ArrayBuffer(0) },
    ];
    const files = readBack(joined(zipStored(entries, AT)));
    expect(files.map((one) => [one.name, one.text])).toEqual([
      ['series/IM0001.dcm', 'first'],
      ['series/IM0002.dcm', 'the second one'],
      ['series/empty', ''],
    ]);
    expect(files[0].crc).toBe(crc32(new TextEncoder().encode('first')));
  });

  it('does not copy the files: their bytes are among its parts as they were given', () => {
    const bytes = bytesOf('kept');
    expect(zipStored([{ name: 'a', bytes }], AT)).toContain(bytes);
  });

  it('says when it was made, as an archive keeps it', () => {
    const view = new DataView(joined(zipStored([{ name: 'a', bytes: bytesOf('x') }], AT)).buffer);
    // 09:05:07 to two seconds, and 14 November 2026.
    expect(view.getUint16(10, true)).toBe((9 << 11) | (5 << 5) | 3);
    expect(view.getUint16(12, true)).toBe((46 << 9) | (11 << 5) | 14);
  });

  it('is an archive of nothing for no files', () => {
    const parts = zipStored([], AT);
    expect(readBack(joined(parts))).toEqual([]);
    expect(joined(parts)).toHaveLength(22);
  });

  it('refuses a name that could land a file elsewhere than in its folder, and a name twice', () => {
    const file = bytesOf('x');
    for (const name of ['../up', '/root', 'a//b', 'a/./b', 'a\\b', 'c:evil', '', 'nül', 'a b']) {
      expect(() => zipStored([{ name, bytes: file }], AT), name).toThrow(ZipError);
    }
    expect(() =>
      zipStored(
        [
          { name: 'a', bytes: file },
          { name: 'a', bytes: file },
        ],
        AT,
      ),
    ).toThrow('An archive cannot hold “a” twice.');
  });

  it('refuses more files than the format holds', () => {
    const one = { name: 'a', bytes: new ArrayBuffer(0) };
    expect(() => zipStored(new Array<ZipEntry>(65_536).fill(one), AT)).toThrow(
      'An archive holds at most 65535 files; this would be 65536.',
    );
  });
});
