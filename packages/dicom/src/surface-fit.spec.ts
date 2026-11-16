/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { visualHull } from './image-aware.js';
import { sliceMask } from './label-rubber-band.js';
import { labelIndex } from './label-volume.js';
import { constraintsOf, fitFromContours, fitSurface, surfaceValue } from './surface-fit.js';

const N = 48;
const DIMS: [number, number, number] = [N, N, N];
const GRID = { dims: DIMS, spacing: [1, 1, 1] as [number, number, number] };
const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return (2 * both) / sum;
};

/** A sphere of radius 15 about the middle, or an ellipsoid (18, 10, 12) turned 30° about z and off it. */
function shape(kind: 'sphere' | 'ellipsoid'): Uint8Array {
  const truth = new Uint8Array(N ** 3);
  const turn = Math.PI / 6;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let inside: boolean;
        if (kind === 'sphere') inside = Math.hypot(x - 24, y - 24, z - 24) <= 15;
        else {
          const [dx, dy, dz] = [x - 26, y - 22, z - 25];
          const u = dx * Math.cos(turn) + dy * Math.sin(turn);
          const v = -dx * Math.sin(turn) + dy * Math.cos(turn);
          inside = (u / 18) ** 2 + (v / 10) ** 2 + (dz / 12) ** 2 <= 1;
        }
        truth[labelIndex(DIMS, x, y, z)] = inside ? 1 : 0;
      }
    }
  }
  return truth;
}

/** The object's sections through the grid's middle, across each axis: through the ellipsoid's, they are not. */
const sections = (truth: Uint8Array) =>
  ([0, 1, 2] as const).map((axis) => ({
    axis,
    slice: 24,
    mask: sliceMask({ dims: DIMS, data: Uint16Array.from(truth, (v) => v * 5) }, 5, axis, 24).mask,
  }));

// What was measured (Dice against the object; 120 points, 2 mm off the surface):
//   sphere from three sections through its middle     hull 0.934, fitted surface 0.980
//   ellipsoid, three sections not through its middle  hull 0.903, fitted surface 0.973
//   the sphere on 3 mm slices                          hull 0.926, fitted surface 0.978
// Each fit took about 1 s on a 48³ grid (single-threaded, Intel Core i7-8850H).
// A fit takes about 1 s alone, and more than Vitest's 5 s while the other
// workspaces' tests run beside it: these tests are given 30 s.
describe('fitting a structure from contours in several planes (#296)', { timeout: 30_000 }, () => {
  it('fits a tilted ellipsoid from sections off its middle, where the hull cut it', () => {
    const truth = shape('ellipsoid');
    const outlines = sections(truth);
    const fitted = dice(fitFromContours(GRID, outlines), truth);
    expect(fitted).toBeGreaterThan(0.95);
    expect(fitted).toBeGreaterThan(dice(visualHull(GRID, outlines), truth));
  });

  it('fits a sphere from three sections through its middle, better than the hull', () => {
    const truth = shape('sphere');
    const outlines = sections(truth);
    const fitted = dice(fitFromContours(GRID, outlines), truth);
    expect(fitted).toBeGreaterThan(0.97);
    expect(fitted).toBeGreaterThan(dice(visualHull(GRID, outlines), truth));
  });

  it('fits a sphere on a grid of 3 mm slices, its normals taken in mm (0.978 measured)', () => {
    const dims: [number, number, number] = [N, N, 16];
    const truth = new Uint8Array(N * N * 16);
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          truth[labelIndex(dims, x, y, z)] = Math.hypot(x - 24, y - 24, 3 * z - 24) <= 15 ? 1 : 0;
        }
      }
    }
    const data = Uint16Array.from(truth, (v) => v * 5);
    const outlines = ([0, 1, 2] as const).map((axis) => {
      const slice = axis === 2 ? 8 : 24;
      return { axis, slice, mask: sliceMask({ dims, data }, 5, axis, slice).mask };
    });
    const fitted = fitFromContours({ dims, spacing: [1, 1, 3] }, outlines);
    expect(dice(fitted, truth)).toBeGreaterThan(0.97);
  });

  it('passes exactly through its constraints, below zero within and above beyond', () => {
    const constraints = constraintsOf(GRID, sections(shape('sphere')));
    const surface = fitSurface(constraints);
    for (const { at, value } of constraints)
      expect(surfaceValue(surface, at)).toBeCloseTo(value, 6);
    expect(surfaceValue(surface, [24, 24, 24])).toBeLessThan(0);
    expect(surfaceValue(surface, [0, 0, 0])).toBeGreaterThan(0);
  });

  it('takes a point where sections cross once, and fits nothing from no outline', () => {
    const constraints = constraintsOf(GRID, sections(shape('sphere')));
    const keys = constraints.map(({ at }) => at.map((v) => v.toFixed(3)).join(','));
    expect(new Set(keys).size).toBe(keys.length);
    expect(fitFromContours(GRID, []).every((v) => v === 0)).toBe(true);
  });
});
