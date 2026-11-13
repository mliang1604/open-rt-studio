/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Imports no package may use: frameworks, Node built-ins, apps and services. */
const FRAMEWORK_AND_NODE = [
  { group: ['@angular/*', 'rxjs', 'rxjs/*'], message: 'Packages are framework-free.' },
  {
    group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'child_process', 'crypto', 'worker_threads'],
    message: 'Packages must run in a browser and a worker, so no Node built-ins.',
  },
  {
    group: ['**/apps/*', '**/services/*'],
    message: 'Packages never import from apps/ or services/.',
  },
];

/** Code outside a package imports its entry point, never a file inside it. */
const NO_DEEP_IMPORTS = {
  group: ['@open-rt-studio/*/*'],
  message: 'Import the package entry point, not a file inside the package.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out-tsc/**',
      '**/.angular/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/third_party/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_DEEP_IMPORTS] }],
    },
  },
  {
    // Repository scripts and tool configuration run in Node.
    files: ['scripts/**/*.mjs', '**/*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // packages/dicom depends on nothing else in the repository.
    files: ['packages/dicom/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_NODE,
            {
              group: ['@open-rt-studio/*'],
              message: 'packages/dicom has no workspace dependencies.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/render depends only on packages/dicom.
    files: ['packages/render/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_NODE,
            NO_DEEP_IMPORTS,
            {
              group: ['@open-rt-studio/*', '!@open-rt-studio/dicom'],
              message: 'packages/render depends only on packages/dicom.',
            },
          ],
        },
      ],
    },
  },
);
