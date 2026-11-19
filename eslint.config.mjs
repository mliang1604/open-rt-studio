/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import js from '@eslint/js';
import angular from 'angular-eslint';
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
      // What CMake builds: ITK and elastix are unpacked there.
      'native/build/**',
      // The desktop application as it is packaged: Electron and the web client's build.
      'apps/desktop/release/**',
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
    // Repository scripts, tool configuration, Node-side package tests and the
    // Playwright side of end-to-end tests run in Node.
    files: [
      'scripts/**/*.mjs',
      'apps/web/scripts/**/*.mjs',
      '**/*.config.{js,mjs,ts}',
      'packages/*/test/**/*.mjs',
      'apps/*/e2e/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // The server runs in Node and inside the desktop application's main
    // process. It has no user interface and is reached over HTTP only.
    files: ['services/*/src/**/*.{ts,mjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DEEP_IMPORTS,
            { group: ['@angular/*', 'rxjs', 'rxjs/*'], message: 'The server has no Angular.' },
            { group: ['**/apps/*'], message: 'The server never imports from apps/.' },
            {
              group: ['@open-rt-studio/render', '@open-rt-studio/web'],
              message: 'The server draws nothing: packages/render and the web client stay out.',
            },
            {
              group: ['dcmjs-dimse', 'dcmjs', 'dcmjs-codecs'],
              message:
                'Only src/dimse/library.ts imports the DIMSE library (docs/dimse-library.md).',
            },
            {
              group: ['pg', 'pg-*'],
              message:
                'Only src/pacs-index/postgres.ts imports node-postgres: nothing of what the database says of a failure leaves it but a code.',
            },
          ],
        },
      ],
    },
  },
  {
    // The Angular application: component and directive conventions, with
    // inline templates linted like template files.
    files: ['apps/web/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
  {
    // The desktop application's main process, preload script and scripts run
    // in Node (the preload script in a sandbox, with `electron` alone).
    files: ['apps/desktop/src/**/*.{ts,cts}', 'apps/desktop/scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DEEP_IMPORTS,
            { group: ['@angular/*', 'rxjs', 'rxjs/*'], message: 'The shell has no Angular.' },
          ],
        },
      ],
    },
  },
  {
    // What the shell decides (policy, files, the bridge's calls) needs no
    // Electron, so that each rule has a test. `main.ts` hands it to Electron.
    files: ['apps/desktop/src/**/*.ts'],
    ignores: ['apps/desktop/src/main.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DEEP_IMPORTS,
            { group: ['@angular/*', 'rxjs', 'rxjs/*'], message: 'The shell has no Angular.' },
            {
              group: ['electron', 'electron/*'],
              message: 'Only main.ts and preload.cts import Electron; keep the rest testable.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/desktop-bridge is types and checks that run anywhere, and
    // depends on nothing.
    files: ['packages/desktop-bridge/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_NODE,
            {
              group: ['@open-rt-studio/*', 'electron', 'electron/*'],
              message: 'packages/desktop-bridge has no dependencies.',
            },
          ],
        },
      ],
    },
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
    // packages/testdata depends only on packages/dicom, which its specs use to
    // read back what the generators wrote.
    files: ['packages/testdata/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_NODE,
            NO_DEEP_IMPORTS,
            {
              group: ['@open-rt-studio/*', '!@open-rt-studio/dicom'],
              message: 'packages/testdata depends only on packages/dicom.',
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
