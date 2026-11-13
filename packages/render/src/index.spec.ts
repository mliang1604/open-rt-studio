/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RENDER_DEPENDS_ON, RENDER_PACKAGE } from './index.js';

describe('@open-rt-studio/render', () => {
  it('has an entry point', () => {
    expect(RENDER_PACKAGE).toBe('@open-rt-studio/render');
  });

  it('depends only on the DICOM core', () => {
    expect(RENDER_DEPENDS_ON).toEqual(['@open-rt-studio/dicom']);
  });

  it('runs without a GPU', () => {
    expect((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu).toBeUndefined();
  });
});
