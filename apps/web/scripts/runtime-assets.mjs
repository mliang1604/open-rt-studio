/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Puts what the application serves and does not bundle where the build
// takes it from: `public/`. Run before the build and before the
// development server (`prebuild`, `prestart` in package.json).
//
// There is one such file: the WebAssembly of ONNX Runtime Web's WebGPU
// build (#340), 29 MB, which the click-to-segment tool's worker fetches
// when a model is first loaded and never before. The build cannot be told
// to take it from the package itself, which npm puts outside this
// workspace. It is not committed (`public/ort` is ignored).

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = [
  { from: 'onnxruntime-web', file: 'dist/ort-wasm-simd-threaded.asyncify.wasm', to: 'ort' },
];

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

for (const { from, file, to } of FILES) {
  // The package's main file is in its `dist`; its folder is one above.
  const source = join(dirname(dirname(require.resolve(from))), file);
  const folder = join(here, '..', 'public', to);
  const target = join(folder, file.split('/').pop());
  if (existsSync(target) && statSync(target).size === statSync(source).size) continue;
  mkdirSync(folder, { recursive: true });
  copyFileSync(source, target);
  console.log(`runtime-assets: ${to}/${file.split('/').pop()} (${statSync(target).size} bytes)`);
}
