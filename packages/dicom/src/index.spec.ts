/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DICOM_PACKAGE } from './index.js';

describe('@open-rt-studio/dicom', () => {
  it('has an entry point', () => {
    expect(DICOM_PACKAGE).toBe('@open-rt-studio/dicom');
  });

  it('runs without a DOM', () => {
    expect(typeof document).toBe('undefined');
  });
});
