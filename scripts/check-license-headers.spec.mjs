/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addHeader, commentStyle, hasHeader, headerFor } from './check-license-headers.mjs';

test('source files need a header, data and docs do not', () => {
  assert.equal(commentStyle('packages/dicom/src/index.ts'), 'block');
  assert.equal(commentStyle('apps/web/src/styles.css'), 'block');
  assert.equal(commentStyle('apps/web/src/index.html'), 'markup');
  assert.equal(commentStyle('native/CMakeLists.txt'), 'hash');
  assert.equal(commentStyle('native/tools/rigid.cpp'), 'block');
  assert.equal(commentStyle('package.json'), null);
  assert.equal(commentStyle('README.md'), null);
  assert.equal(commentStyle('.github/workflows/ci.yml'), null);
});

test('third-party and generated directories are skipped', () => {
  assert.equal(commentStyle('native/third_party/lib/a.cpp'), null);
  assert.equal(commentStyle('packages/dicom/dist/index.js'), null);
  assert.equal(commentStyle('node_modules/x/index.js'), null);
});

test('every header style is recognized', () => {
  for (const style of ['block', 'markup', 'hash']) {
    assert.equal(hasHeader(`${headerFor(style)}\n\ncode\n`), true, style);
  }
});

test('a missing or partial header is reported', () => {
  assert.equal(hasHeader('export const x = 1;\n'), false);
  assert.equal(hasHeader('/* This Source Code Form is subject to the MIT license. */\n'), false);
  assert.equal(hasHeader(`const x = 1;\n${headerFor('block')}\n`), false);
});

test('a shebang or doctype may come first', () => {
  assert.equal(hasHeader(`#!/usr/bin/env node\n${headerFor('block')}\n`), true);
  assert.equal(hasHeader(`<!doctype html>\n${headerFor('markup')}\n<html></html>\n`), true);
});

test('addHeader puts the header first and keeps the content', () => {
  const fixed = addHeader('export const x = 1;\n', 'block');
  assert.equal(hasHeader(fixed), true);
  assert.equal(fixed.endsWith('\n\nexport const x = 1;\n'), true);

  const script = addHeader('#!/bin/sh\necho hi\n', 'hash');
  assert.equal(script.startsWith('#!/bin/sh\n# This Source Code Form'), true);
  assert.equal(hasHeader(script), true);
});
