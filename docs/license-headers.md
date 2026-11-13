# License headers

Open RT Studio is licensed under the Mozilla Public License 2.0. MPL is a
file-level license, so each source file carries the standard notice.

## Which files

Hand-written source files with these extensions need the header: `.ts`,
`.mts`, `.js`, `.mjs`, `.css`, `.wgsl`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`.

These do not: configuration and data files (`.json`, `.yml`, `.md`), HTML
templates, generated files, and third-party files, which keep their own notice.

## Header text

```
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

For `.wgsl` files use `//` line comments with the same words.

## Tooling

`npm run lint` fails when a file is missing the header.
`node scripts/check-headers.mjs --fix` adds it.

## Code ported from dicom-workspace

Files ported from [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
were MIT-licensed by the same author and are relicensed here under MPL 2.0.
