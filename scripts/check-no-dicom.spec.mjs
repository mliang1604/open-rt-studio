/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { dicomReason, findDicomFiles, hasDicomMarker, parseAllowlist } from './check-no-dicom.mjs';

/** The smallest thing the guard must catch: a 128-byte preamble and "DICM". */
function part10Head() {
  const bytes = new Uint8Array(200);
  bytes.set([0x44, 0x49, 0x43, 0x4d], 128);
  return bytes;
}

test('the DICM marker is found only at byte 128', () => {
  assert.equal(hasDicomMarker(part10Head()), true);
  assert.equal(hasDicomMarker(new Uint8Array(200)), false);
  assert.equal(hasDicomMarker(new TextEncoder().encode('DICM')), false);
  assert.equal(hasDicomMarker(new Uint8Array(100)), false);
});

test('a DICOM extension is flagged whatever the content', () => {
  assert.match(dicomReason('scan/IM0001.dcm', new Uint8Array(0)), /extension/);
  assert.match(dicomReason('scan/IM0001.DCM', new Uint8Array(0)), /extension/);
  assert.match(dicomReason('export.dicom', new Uint8Array(0)), /extension/);
});

test('a DICOM file with another name is flagged by its marker', () => {
  assert.match(dicomReason('scan/IM0001', part10Head()), /DICM/);
  assert.match(dicomReason('assets/sample.bin', part10Head()), /DICM/);
});

test('ordinary files pass', () => {
  const source = new TextEncoder().encode('export const DICM = "DICM";\n'.repeat(20));
  assert.equal(dicomReason('packages/dicom/src/loader.ts', source), null);
  assert.equal(dicomReason('README.md', new Uint8Array(0)), null);
});

test('the allow-list ignores comments and blank lines', () => {
  const list = parseAllowlist('# comment\n\nfixtures/public/phantom.dcm  # CC0, source in PR\n');
  assert.deepEqual([...list], ['fixtures/public/phantom.dcm']);
});

test('planted files are found on disk and the allow-list exempts them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dicom-guard-'));
  try {
    const planted = join(dir, 'planted-image');
    const named = join(dir, 'empty.dcm');
    const clean = join(dir, 'notes.txt');
    writeFileSync(planted, part10Head());
    writeFileSync(named, '');
    writeFileSync(clean, 'nothing to see');

    const found = findDicomFiles([planted, named, clean, join(dir, 'missing')]);
    assert.deepEqual(found.map((f) => f.path).sort(), [named, planted].sort());

    assert.deepEqual(findDicomFiles([planted, named, clean], new Set([planted, named])), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
