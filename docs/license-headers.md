# License headers

Open RT Studio is licensed under the [Mozilla Public License 2.0](../LICENSE).
MPL is a file-level license, so every source file says so at the top.

## Header text

For languages with block comments (TypeScript, JavaScript, CSS, WGSL, C++):

```
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

For HTML and Angular templates:

```
<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
```

For languages with line comments (shell, CMake, YAML):

```
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

The header is the first thing in the file. Only a shebang line (`#!`) or an
HTML `<!doctype>` may come before it. Leave one blank line after it.

## Which files need it

Required, and checked in CI by `scripts/check-license-headers.mjs`:

| Kind                    | Extensions                                           |
| ----------------------- | ---------------------------------------------------- |
| TypeScript, JavaScript  | `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`         |
| Styles                  | `.css`, `.scss`                                      |
| Templates and pages     | `.html`                                              |
| Shaders                 | `.wgsl`                                              |
| C and C++               | `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`     |
| Build and shell scripts | `.sh`, `.cmake`, `CMakeLists.txt`                    |

Not required:

- Files that cannot carry comments or where one would be noise: JSON, lock
  files, images and other binaries.
- Documentation (`.md`) and repository configuration (`.yml`, `.editorconfig`,
  `.gitignore` and similar). They are still covered by the license of the
  repository.
- Generated files and build output.
- Third-party files kept in the repository. They keep their own license
  notice and go in a directory named `third_party/`.

## Ported code

Files ported from [dicom-workspace](https://github.com/mliang1604/dicom-workspace)
were MIT-licensed by the same author, who relicenses them here. They get the
MPL header like any new file. No separate MIT notice is kept in the file.

## Dependencies

Dependencies must have a license compatible with distributing the application
under MPL 2.0. **No GPL or AGPL dependencies**, including in `native/`. LGPL
needs a discussion in the issue before it is added. Check the license of every
new dependency and say what it is in the pull request.
