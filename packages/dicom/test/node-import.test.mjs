/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Imports the built package by name, the way a Node consumer outside the
// workspace would, and parses a small synthetic file. The Vitest specs run the
// TypeScript source through a bundler-style resolver, which hides mistakes
// that only break real Node ESM (a missing ".js" extension, or a namespace
// import of a CommonJS dependency). This test is what catches those.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupSeries, parseFile } from '@open-rt-studio/dicom';

const encoder = new TextEncoder();

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u16 = (n) => new Uint8Array(new Uint16Array([n]).buffer);
const u32 = (n) => new Uint8Array(new Uint32Array([n]).buffer);

/** One explicit-VR little-endian data element. */
function element(group, elem, vr, value) {
  let bytes = value;
  if (typeof value === 'string') {
    const padded = value.length % 2 === 0 ? value : value + (vr === 'UI' ? '\0' : ' ');
    bytes = encoder.encode(padded);
  }
  const longForm = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const head = new Uint8Array(longForm ? 12 : 8);
  const view = new DataView(head.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, elem, true);
  head[4] = vr.charCodeAt(0);
  head[5] = vr.charCodeAt(1);
  if (longForm) view.setUint32(8, bytes.length, true);
  else view.setUint16(6, bytes.length, true);
  return concat([head, bytes]);
}

/** A 2x2 synthetic CT slice at height z. No patient data. */
function syntheticSlice(z, pixelValues) {
  const meta = concat([
    element(0x0002, 0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.2'),
    element(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
  ]);
  const body = concat([
    element(0x0008, 0x0060, 'CS', 'CT'),
    element(0x0010, 0x0010, 'PN', 'SYNTHETIC^PHANTOM'),
    element(0x0020, 0x000e, 'UI', '1.2.826.0.1.3680043.10.1.1'),
    element(0x0020, 0x0032, 'DS', `0\\0\\${z}`),
    element(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    element(0x0028, 0x0002, 'US', u16(1)),
    element(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    element(0x0028, 0x0010, 'US', u16(2)),
    element(0x0028, 0x0011, 'US', u16(2)),
    element(0x0028, 0x0030, 'DS', '1\\1'),
    element(0x0028, 0x0100, 'US', u16(16)),
    element(0x0028, 0x0101, 'US', u16(16)),
    element(0x0028, 0x0102, 'US', u16(15)),
    element(0x0028, 0x0103, 'US', u16(1)),
    element(0x7fe0, 0x0010, 'OW', new Uint8Array(new Int16Array(pixelValues).buffer)),
  ]);
  const file = concat([
    new Uint8Array(128),
    encoder.encode('DICM'),
    element(0x0002, 0x0000, 'UL', u32(meta.length)),
    meta,
    body,
  ]);
  return file.buffer;
}

test('the built package parses a synthetic slice in plain Node', () => {
  const slices = parseFile('synthetic-0', syntheticSlice(0, [0, 100, 200, 300]));
  assert.equal(slices.length, 1);
  assert.equal(slices[0].rows, 2);
  assert.equal(slices[0].columns, 2);
  assert.deepEqual(Array.from(slices[0].pixels), [0, 100, 200, 300]);
});

test('slices from one series group together', () => {
  const slices = [0, 1, 2].flatMap((z) =>
    parseFile(`synthetic-${z}`, syntheticSlice(z, [z, z, z, z])),
  );
  const series = groupSeries(slices);
  assert.equal(series.length, 1);
  assert.equal(series[0].slices.length, 3);
});
