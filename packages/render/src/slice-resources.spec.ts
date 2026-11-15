/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { f32ToF16 } from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import { texelsOf } from './slice-resources.js';
import { SLICE_SHADER, UNKNOWN_TEXEL, UNKNOWN_TEXEL_BELOW } from './slice-shader.js';

describe('what goes into a volume’s texture', () => {
  it('is the volume’s own values, when it is known everywhere', () => {
    const data = Float32Array.of(0, 1.5, -1024, 3071);
    expect(texelsOf({ data })).toBe(data);
  });

  it('marks the voxels that are not known, in a copy', () => {
    const data = Float32Array.of(5, 0, 7, 0);
    const texels = texelsOf({ data, known: Uint8Array.of(1, 0, 1, 1) });
    // The second voxel is not known; the fourth is known, and is 0.
    expect([...texels]).toEqual([5, UNKNOWN_TEXEL, 7, 0]);
    expect([...data]).toEqual([5, 0, 7, 0]);
  });

  it('marks them with a number a half float holds, below anything an image has', () => {
    // 0xfbff is the least finite half float, -65504: the mark is above it.
    expect(UNKNOWN_TEXEL).toBeGreaterThan(-65504);
    expect(f32ToF16(UNKNOWN_TEXEL) & 0x7c00).not.toBe(0x7c00);
    // A CT's stored values go no lower than -32768 less its intercept of 1024.
    expect(UNKNOWN_TEXEL_BELOW).toBeLessThan(-32768 - 1024);
    expect(UNKNOWN_TEXEL).toBeLessThan(UNKNOWN_TEXEL_BELOW);
  });

  it('is not drawn by the shader, which goes by the same number', () => {
    expect(SLICE_SHADER).toContain(`let oknown = oraw > ${UNKNOWN_TEXEL_BELOW}.0;`);
    expect(SLICE_SHADER).toMatch(/if \(!oknown\) \{\s*amount = 0\.0;\s*\}/);
  });
});
