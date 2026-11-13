/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CprImage } from '@open-rt-studio/render';

/**
 * A reformat as 8-bit RGBA for a 2D canvas, with the same linear window the
 * MPR panes use: values at or below `center - width / 2` are black, at or
 * above `center + width / 2` white. Samples the reformat could not take (the
 * path left the volume) are NaN and come out black.
 */
export function cprToRgba(
  image: CprImage,
  center: number,
  width: number,
  invert = false,
): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  const low = center - width / 2;
  const scale = 255 / Math.max(width, 1e-6);
  for (let i = 0; i < image.data.length; i++) {
    const value = image.data[i];
    let gray = Number.isNaN(value) ? 0 : Math.min(255, Math.max(0, (value - low) * scale));
    if (invert) gray = 255 - gray;
    const o = i * 4;
    rgba[o] = gray;
    rgba[o + 1] = gray;
    rgba[o + 2] = gray;
    rgba[o + 3] = 255;
  }
  return rgba;
}
