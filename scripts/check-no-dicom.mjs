/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fails when a file in the repository looks like DICOM: this repository is
// public and must never contain patient data (docs/test-data.md). Tests build
// their inputs in memory with @open-rt-studio/testdata instead.
//
//   node scripts/check-no-dicom.mjs [file ...]
//
// A file is flagged when it has a DICOM file extension or carries the Part 10
// marker "DICM" at byte 128. With no files given it checks everything git
// tracks plus untracked files that are not ignored. Paths listed in
// scripts/dicom-allowlist.txt are skipped.

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { extname } from 'node:path';

const DICOM_EXTENSIONS = new Set(['.dcm', '.dicom', '.dic', '.ima']);
const ALLOWLIST = new URL('./dicom-allowlist.txt', import.meta.url);

/** True when the bytes are long enough and have "DICM" at offset 128. */
export function hasDicomMarker(bytes) {
  return (
    bytes.length >= 132 &&
    bytes[128] === 0x44 && // D
    bytes[129] === 0x49 && // I
    bytes[130] === 0x43 && // C
    bytes[131] === 0x4d // M
  );
}

/** Why a path is flagged, or null when it is fine. `head` is its first 132 bytes. */
export function dicomReason(path, head) {
  if (DICOM_EXTENSIONS.has(extname(path).toLowerCase())) return 'has a DICOM file extension';
  if (hasDicomMarker(head)) return 'has the DICM marker at byte 128';
  return null;
}

/** Paths from an allow-list file: one per line, "#" starts a comment. */
export function parseAllowlist(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
}

function readHead(path) {
  const head = Buffer.alloc(132);
  let fd;
  try {
    fd = openSync(path, 'r');
    const n = readSync(fd, head, 0, 132, 0);
    return head.subarray(0, n);
  } catch {
    return null; // deleted in the working tree, a directory, or unreadable
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function listFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out.split('\0').filter(Boolean);
}

/** Check paths and return the flagged ones as `{ path, reason }`. */
export function findDicomFiles(paths, allowlist = new Set()) {
  const found = [];
  for (const path of paths) {
    if (allowlist.has(path)) continue;
    const head = readHead(path);
    if (head === null) continue;
    const reason = dicomReason(path, head);
    if (reason) found.push({ path, reason });
  }
  return found;
}

function main(argv) {
  const files = argv.length > 0 ? argv : listFiles();
  const allowlist = parseAllowlist(readFileSync(ALLOWLIST, 'utf8'));
  const found = findDicomFiles(files, allowlist);
  if (found.length === 0) {
    console.log(`DICOM guard: ${files.length} files checked, none look like DICOM.`);
    return 0;
  }
  console.error(`DICOM guard: ${found.length} file(s) look like DICOM and must not be committed:`);
  for (const { path, reason } of found) console.error(`  ${path} (${reason})`);
  console.error('Never commit patient data. Tests generate synthetic data in memory instead.');
  console.error('See docs/test-data.md.');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
