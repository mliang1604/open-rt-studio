/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CprImage } from '@open-rt-studio/render';

import { cprToRgba } from './cpr-image';

const image = (values: number[], width: number): CprImage => ({
  data: Float32Array.from(values),
  width,
  height: values.length / width,
  mmPerColumn: 1,
  mmPerRow: 1,
});

const grays = (rgba: Uint8ClampedArray): number[] =>
  Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4]);

describe('cprToRgba', () => {
  it('maps the window linearly from black to white', () => {
    const rgba = cprToRgba(image([0, 500, 1000, 1500, 2000, 3000], 3), 1000, 2000);
    expect(grays(rgba)).toEqual([0, 64, 128, 191, 255, 255]);
  });

  it('writes opaque gray pixels', () => {
    const rgba = cprToRgba(image([1000], 1), 1000, 2000);
    expect(Array.from(rgba)).toEqual([128, 128, 128, 255]);
  });

  it('clips below and above the window', () => {
    expect(grays(cprToRgba(image([-5000, 5000], 2), 0, 100))).toEqual([0, 255]);
  });

  it('inverts when asked', () => {
    expect(grays(cprToRgba(image([0, 2000], 2), 1000, 2000, true))).toEqual([255, 0]);
  });

  it('draws samples outside the volume black', () => {
    expect(grays(cprToRgba(image([Number.NaN, 2000], 2), 1000, 2000))).toEqual([0, 255]);
  });

  it('survives a zero-width window', () => {
    expect(grays(cprToRgba(image([9, 10, 11], 3), 10, 0))).toEqual([0, 0, 255]);
  });
});
