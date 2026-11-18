/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { configureArguments, folders, isBuildLeftover } from './native.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('the folders of a build are under the one it is rooted in', () => {
  const at = folders(join('some', 'where'));
  assert.equal(at.prefix, join('some', 'where', 'prefix'));
  assert.equal(at.deps, join('some', 'where', 'deps'));
  assert.equal(at.tools, join('some', 'where', 'tools'));
  assert.equal(at.dist, join('some', 'where', 'dist'));
});

test('a build is optimised, with Ninja when it is there', () => {
  assert.deepEqual(configureArguments({ platform: 'linux', arch: '', ninja: false }), [
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
  assert.deepEqual(configureArguments({ platform: 'win32', arch: '', ninja: true }), [
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
});

test('macOS is built for one processor, which can be named', () => {
  assert.deepEqual(configureArguments({ platform: 'darwin', arch: 'x86_64', ninja: false }), [
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_OSX_ARCHITECTURES=x86_64',
  ]);
  assert.deepEqual(configureArguments({ platform: 'darwin', arch: '', ninja: false }), [
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
  // Not both at once, and nothing that is passed on unlooked at.
  assert.throws(() =>
    configureArguments({ platform: 'darwin', arch: 'arm64;x86_64', ninja: false }),
  );
  assert.throws(() => configureArguments({ platform: 'darwin', arch: 'universal', ninja: false }));
  // The setting means nothing elsewhere.
  assert.deepEqual(configureArguments({ platform: 'linux', arch: 'arm64', ninja: false }), [
    '-DCMAKE_BUILD_TYPE=Release',
  ]);
});

test('what is pruned is what only a build needed, never a library or a header', () => {
  for (const name of ['a.o', 'b.obj', 'c.pdb', 'd.tlog', 'e.d']) {
    assert.equal(isBuildLeftover(name), true, name);
  }
  for (const name of [
    'libelastix-5.3.1.a',
    'elastix-5.3.1.lib',
    'ElastixConfig.cmake',
    'elxSupportedImageTypes.h',
    'LICENSE',
    'elastix.stamp',
  ]) {
    assert.equal(isBuildLeftover(name), false, name);
  }
});

test('what is pinned is pinned by a checksum, and the documents name the same versions', () => {
  const versions = read('native/cmake/versions.cmake');
  const itk = /set\(ORS_ITK_VERSION ([0-9.]+)\)/.exec(versions)?.[1];
  const elastix = /set\(ORS_ELASTIX_VERSION ([0-9.]+)\)/.exec(versions)?.[1];
  assert.match(itk ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(elastix ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(versions, /set\(ORS_ITK_SHA512\s+"[0-9a-f]{128}"\s*\)/);
  assert.match(versions, /set\(ORS_ELASTIX_SHA256\s+"[0-9a-f]{64}"\s*\)/);
  assert.match(versions, /set\(ORS_ELASTIX_COMMIT [0-9a-f]{40}\)/);
  // Fetched over HTTPS from where the projects publish, and checked.
  const deps = read('native/deps/CMakeLists.txt');
  assert.match(deps, /URL_HASH SHA512=\$\{ORS_ITK_SHA512\}/);
  assert.match(deps, /URL_HASH SHA256=\$\{ORS_ELASTIX_SHA256\}/);
  for (const url of versions.match(/"https?:[^"]+"/g) ?? []) {
    assert.match(
      url,
      /^"https:\/\/github\.com\/(InsightSoftwareConsortium\/ITK|SuperElastix\/elastix)\//,
    );
  }
  for (const document of ['native/THIRD-PARTY.md', 'native/README.md']) {
    const text = read(document);
    assert.ok(text.includes(`ITK ${itk}`), `${document} names ITK ${itk}`);
    assert.ok(text.includes(`elastix ${elastix}`), `${document} names elastix ${elastix}`);
  }
});

test('what is GPL or LGPL stays out of the build', () => {
  const deps = read('native/deps/CMakeLists.txt');
  for (const off of [
    '-DITK_USE_FFTWF:BOOL=OFF',
    '-DITK_USE_FFTWD:BOOL=OFF',
    '-DUSE_KNNGraphAlphaMutualInformationMetric:BOOL=OFF',
    '-DUSE_ALL_COMPONENTS:BOOL=OFF',
    '-DITK_USE_EIGEN_MPL2_ONLY:BOOL=ON',
    '-DITK_FORBID_DOWNLOADS:BOOL=ON',
  ]) {
    assert.ok(deps.includes(off), off);
  }
});

test('every library of others that ITK carries is written down with its licence', () => {
  const modules = read('native/cmake/itk_modules.cmake');
  const list = /set\(ORS_ITK_THIRD_PARTY\n([\s\S]*?)\)/.exec(modules)?.[1] ?? '';
  const names = list.split(/\s+/).filter((name) => name !== '');
  assert.ok(names.length > 10);
  const document = read('native/THIRD-PARTY.md');
  for (const name of names) {
    assert.ok(document.includes(`\`${name}\``), `${name} is in native/THIRD-PARTY.md`);
  }
});
