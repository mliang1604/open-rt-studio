/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { visualHull } from './image-aware.js';
import { sliceMask } from './label-rubber-band.js';
import { labelIndex } from './label-volume.js';
import {
  constraintsOf,
  fitFromContours,
  fitSurface,
  planeOutlineOf,
  sectionOf,
  surfaceValue,
  type PlaneSpan,
} from './surface-fit.js';

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
//   the sphere on 3 mm slices                          hull 0.926, fitted surface 0.980 (#302: 6 mm off)
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

  it('fits a sphere on a grid of 3 mm slices, its normals taken in mm (0.980 measured)', () => {
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

// What was measured (#302; Dice against the tilted ellipsoid, 120 points):
//   three oblique sections near its middle (tilted 30°, 25°, 20°)     0.955
//     (#303: the second of #302's three was the coronal plane on skewed axes,
//     not a tilted one; with three truly tilted planes it is 0.955 still)
//   axial 19, 25, 31, sagittal 26, coronal 22   0.977; the fullest of each axis   0.973
//   axial 19, 25, 31, sagittal 26               0.968; the fullest of each axis   0.975
// The last: beyond the outermost axial sections the surface bulges (some 45
// voxels too many a slice) where only the one sagittal outline holds it.
describe('fitting from sections on any plane (#302)', { timeout: 30_000 }, () => {
  type V = [number, number, number];
  const truth = shape('ellipsoid');
  const label = { ...GRID, data: Uint16Array.from(truth, (v) => v * 5) };
  const at = (axis: 0 | 1 | 2, slice: number) => ({
    axis,
    slice,
    mask: sliceMask(label, 5, axis, slice).mask,
  });
  /** Turn a direction about a grid axis. */
  const turn = (v: V, axis: 0 | 1 | 2, degrees: number): V => {
    const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const out: V = [...v];
    out[a] = c * v[a] - s * v[b];
    out[b] = s * v[a] + c * v[b];
    return out;
  };
  /** The plane through `p` along `e1` and `e2`, 64 voxels each way. */
  const plane = (p: V, e1: V, e2: V): PlaneSpan => ({
    origin: [0, 1, 2].map((k) => p[k] - 32 * e1[k] - 32 * e2[k]) as unknown as V,
    alongU: e1.map((c) => 64 * c) as unknown as V,
    alongV: e2.map((c) => 64 * c) as unknown as V,
  });

  it('fits the tilted ellipsoid from three oblique sections', () => {
    const p: V = [25, 23, 24];
    const sections = [
      // Axial tilted 30° about x; coronal turned 25° about z; sagittal tilted 20° about y.
      plane(p, [1, 0, 0], turn([0, 1, 0], 0, 30)),
      plane(p, turn([1, 0, 0], 2, 25), [0, 0, 1]),
      plane(p, [0, 1, 0], turn([0, 0, 1], 1, 20)),
    ].map((one) => sectionOf(label, 5, one));
    expect(dice(fitFromContours(label, sections), truth)).toBeGreaterThan(0.95);
  });

  it('takes every section drawn: several on one axis and one on each other, better than the fullest of each', () => {
    const several = dice(
      fitFromContours(label, [at(2, 19), at(2, 25), at(2, 31), at(0, 26), at(1, 22)]),
      truth,
    );
    const fullest = dice(fitFromContours(label, [at(2, 25), at(0, 26), at(1, 22)]), truth);
    expect(several).toBeGreaterThan(fullest);
  });

  it('samples a section on a plane as the slice it is, and nothing off the grid', () => {
    const axial = sectionOf(label, 5, {
      origin: [-0.5, -0.5, 25],
      alongU: [48, 0, 0],
      alongV: [0, 48, 0],
    });
    expect([axial.width, axial.height]).toEqual([48, 48]);
    expect(axial.mask).toEqual(at(2, 25).mask);
    const beyond = sectionOf(label, 5, {
      origin: [-0.5, -0.5, 60],
      alongU: [48, 0, 0],
      alongV: [0, 48, 0],
    });
    expect(beyond.mask.every((v) => v === 0)).toBe(true);
  });

  it('fits a slice’s outline and the same outline on its plane alike', () => {
    const outlines = [at(2, 25), at(0, 26)];
    expect(
      fitFromContours(
        label,
        outlines.map((one) => planeOutlineOf(label, one)),
      ),
    ).toEqual(fitFromContours(label, outlines));
  });

  it('fits small drawn discs on 4 mm voxels without a lobe far from them (#302)', () => {
    // As drawn in the viewer: discs of 15 mm (under 4 voxels) on axial slices
    // 22, 24 and 26 (the outer two 1.7 voxels off), on a coronal and on a
    // sagittal slice. With points 2 mm off the surface, 1,249 voxels were
    // fitted more than 3 voxels beyond the discs.
    const data = new Uint16Array(N ** 3);
    const disc = (axis: 0 | 1 | 2, slice: number, cu: number, cv: number) => {
      const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
      for (let v = 0; v < N; v++) {
        for (let u = 0; u < N; u++) {
          if (Math.hypot(u - cu, v - cv) > 3.75) continue;
          const p: [number, number, number] = [0, 0, 0];
          p[axis] = slice;
          p[a] = u;
          p[b] = v;
          data[labelIndex(DIMS, ...p)] = 5;
        }
      }
    };
    disc(2, 24, 24, 24);
    disc(2, 22, 24, 25.7);
    disc(2, 26, 24, 25.7);
    disc(1, 24, 24, 24);
    disc(0, 24, 24, 24);
    const drawn = { dims: DIMS, spacing: [4, 4, 4] as [number, number, number], data };
    const outlines = (
      [
        [2, 22],
        [2, 24],
        [2, 26],
        [1, 24],
        [0, 24],
      ] as const
    ).map(([axis, slice]) => ({
      axis,
      slice,
      mask: sliceMask(drawn, 5, axis, slice).mask,
    }));
    const fitted = fitFromContours(drawn, outlines);
    let far = 0;
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (fitted[labelIndex(DIMS, x, y, z)] && Math.hypot(x - 24, y - 25, z - 24) > 3.75 + 3)
            far++;
        }
      }
    }
    expect(far).toBe(0);
    expect(fitted.some((v) => v === 1)).toBe(true);
  });
});
