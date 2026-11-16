/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { labelIndex } from './label-volume.js';
import { slicePlane } from './live-wire.js';
import { fillSliceLoop, type PlanePoint } from './polygon-spline.js';
import { fitFromContours, sectionOf, type PlaneSpan } from './surface-fit.js';
import {
  fillPlaneLoop,
  gridPlaneOf,
  planeImage,
  planePointMm,
  planeRaster,
  planeVoxelAt,
  sheetHalfMm,
  sheetVoxels,
  strokePixels,
} from './tilted-plane.js';

type V = [number, number, number];

/** Turn a direction about a grid axis. */
const turn = (v: V, axis: 0 | 1 | 2, degrees: number): V => {
  const [c, s] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
  const out: V = [...v];
  out[a] = c * v[a] - s * v[b];
  out[b] = s * v[a] + c * v[b];
  return out;
};

/** A circle of `radius` mm about (`a`, `b`) on a plane, as a loop. */
const circle = (a: number, b: number, radius: number, points = 90): PlanePoint[] =>
  Array.from({ length: points }, (_, i): PlanePoint => {
    const angle = (2 * Math.PI * i) / points;
    return [a + radius * Math.cos(angle), b + radius * Math.sin(angle)];
  });

const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return (2 * both) / sum;
};

describe('a plane through the grid (#303)', () => {
  const spacing: V = [1, 1, 2];
  // Through voxel (20, 20, 10), tilted 30° about x: in mm, along x and along (0, cos 30°, sin 30°).
  const along: V = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const plane: PlaneSpan = {
    origin: [0, 20 - 20 * along[1], 10 - (20 * along[2]) / 2],
    alongU: [40, 0, 0],
    alongV: [0, 40 * along[1], (40 * along[2]) / 2],
  };

  it('is a normal of length 1 and an offset in mm of the grid', () => {
    const { normal, offsetMm } = gridPlaneOf(plane, spacing)!;
    expect(Math.hypot(...normal)).toBeCloseTo(1, 12);
    expect(normal[0]).toBeCloseTo(0, 12);
    expect(normal[1]).toBeCloseTo(-0.5, 12);
    expect(normal[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    // Voxel (20, 20, 10) is on it: at (20, 20, 20) mm.
    expect(normal[0] * 20 + normal[1] * 20 + normal[2] * 20).toBeCloseTo(offsetMm, 9);
    expect(sheetHalfMm(normal, spacing)).toBeCloseTo(0.5 * (0.5 + 2 * Math.cos(Math.PI / 6)), 12);
    expect(gridPlaneOf({ ...plane, alongV: [0, 0, 0] }, spacing)).toBeNull();
  });

  it('gives a point its millimetres along the plane, and takes them back to the point', () => {
    const at = planePointMm(plane, spacing, [20, 20, 10])!;
    expect(at[0]).toBeCloseTo(20, 9);
    expect(at[1]).toBeCloseTo(20, 9);
    const voxel = planeVoxelAt(plane, spacing, [12.5, 31])!;
    const back = planePointMm(plane, spacing, voxel)!;
    expect(back[0]).toBeCloseTo(12.5, 9);
    expect(back[1]).toBeCloseTo(31, 9);
    // A point off the plane has its foot's.
    const { normal } = gridPlaneOf(plane, spacing)!;
    const off: V = [voxel[0] + 3 * normal[0], voxel[1] + 3 * normal[1], voxel[2] + 1.5 * normal[2]];
    expect(planePointMm(plane, spacing, off)![1]).toBeCloseTo(31, 9);
  });
});

describe('filling a closed curve on a plane (#303)', () => {
  it('fills a slice of the grid as the slice fill does', () => {
    const dims: V = [24, 20, 6];
    const spacing: V = [0.8, 1.25, 3];
    const axial: PlaneSpan = { origin: [-0.5, -0.5, 4], alongU: [24, 0, 0], alongV: [0, 20, 0] };
    // A loop in mm of the plane, and the same in voxels of the slice.
    const loopMm = circle(9.1, 12.3, 6.2, 37);
    const loop = loopMm.map(([a, b]): PlanePoint => [a / 0.8 - 0.5, b / 1.25 - 0.5]);
    const filled = fillPlaneLoop(dims, spacing, axial, loopMm);
    expect(filled.length).toBeGreaterThan(80);
    expect(filled).toEqual(fillSliceLoop(dims, 2, 4, loop));
  });

  it('fills a sheet a voxel thick on a tilted plane: the curve’s area, with no holes', () => {
    const dims: V = [40, 40, 24];
    const spacing: V = [1, 1, 2];
    const along: V = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const plane: PlaneSpan = {
      origin: [0, 20 - 20 * along[1], 12 - (20 * along[2]) / 2],
      alongU: [40, 0, 0],
      alongV: [0, 40 * along[1], (40 * along[2]) / 2],
    };
    const radius = 11;
    const filled = fillPlaneLoop(dims, spacing, plane, circle(20, 20, radius));
    const { normal, offsetMm } = gridPlaneOf(plane, spacing)!;
    const half = sheetHalfMm(normal, spacing);
    const slices = new Set<number>();
    for (const index of filled) {
      const [x, y, z] = [index % 40, Math.floor(index / 40) % 40, Math.floor(index / 1600)];
      slices.add(z);
      // On the sheet, and its foot within the circle.
      const off = normal[0] * x + normal[1] * y + normal[2] * z * 2 - offsetMm;
      expect(Math.abs(off)).toBeLessThanOrEqual(half + 1e-9);
      const [a, b] = planePointMm(plane, spacing, [x, y, z])!;
      expect(Math.hypot(a - 20, b - 20)).toBeLessThanOrEqual(radius + 1e-9);
    }
    // It crosses several slices of the grid.
    expect(slices.size).toBeGreaterThan(3);
    // Seen on its own plane it is the disc: every pixel within, none without.
    const label = { dims, spacing, data: new Uint16Array(40 * 40 * 24) };
    for (const index of filled) label.data[index] = 5;
    const section = sectionOf(label, 5, plane);
    let [within, held, stray] = [0, 0, 0];
    for (let v = 0; v < section.height; v++) {
      for (let u = 0; u < section.width; u++) {
        const [a, b] = [(u + 0.5) * (40 / section.width), (v + 0.5) * (40 / section.height)];
        const far = Math.hypot(a - 20, b - 20);
        const on = section.mask[v * section.width + u] === 1;
        // A pixel well within the circle is held; one well without is not.
        if (far <= radius - 1.5) {
          within++;
          if (on) held++;
        } else if (far >= radius + 1.5 && on) stray++;
      }
    }
    expect(within).toBeGreaterThan(250);
    expect(held).toBe(within);
    expect(stray).toBe(0);
  });

  it('fills nothing for fewer than three points, a plane with no area, or a curve off the grid', () => {
    const dims: V = [8, 8, 8];
    const spacing: V = [1, 1, 1];
    const axial: PlaneSpan = { origin: [-0.5, -0.5, 3], alongU: [8, 0, 0], alongV: [0, 8, 0] };
    expect(fillPlaneLoop(dims, spacing, axial, circle(4, 4, 2).slice(0, 2))).toEqual([]);
    expect(fillPlaneLoop(dims, spacing, { ...axial, alongU: [0, 0, 0] }, circle(4, 4, 2))).toEqual(
      [],
    );
    expect(fillPlaneLoop(dims, spacing, axial, circle(40, 40, 2))).toEqual([]);
    // Half off the grid: only what is on it.
    const partly = fillPlaneLoop(dims, spacing, axial, circle(0, 4, 2.2));
    expect(partly.length).toBeGreaterThan(0);
    expect(partly.every((index) => index >= 3 * 64 && index < 4 * 64)).toBe(true);
  });
});

// What was measured (#303; Dice against the tilted ellipsoid of the fit's own tests, 120 points),
// on three tilted planes near its middle (axial tilted 30° about x, coronal
// turned 25° about z, sagittal tilted 20° about y):
//   its outline filled on each by `fillPlaneLoop`, then fitted from their sections   0.9501
//   fitted from the ellipsoid's own sections on them                                  0.9547
describe('fitting from curves filled on tilted planes (#303)', { timeout: 30_000 }, () => {
  const N = 48;
  const dims: V = [N, N, N];
  const spacing: V = [1, 1, 1];
  const turned = Math.PI / 6;
  /** The fit's own ellipsoid: (18, 10, 12) turned 30° about z, about (26, 22, 25). */
  const inside = (x: number, y: number, z: number): boolean => {
    const [dx, dy, dz] = [x - 26, y - 22, z - 25];
    const u = dx * Math.cos(turned) + dy * Math.sin(turned);
    const v = -dx * Math.sin(turned) + dy * Math.cos(turned);
    return (u / 18) ** 2 + (v / 10) ** 2 + (dz / 12) ** 2 <= 1;
  };
  /** The plane through `p` along `e1` and `e2`, 64 voxels each way. */
  const through = (p: V, e1: V, e2: V): PlaneSpan => ({
    origin: [0, 1, 2].map((k) => p[k] - 32 * e1[k] - 32 * e2[k]) as unknown as V,
    alongU: e1.map((c) => 64 * c) as unknown as V,
    alongV: e2.map((c) => 64 * c) as unknown as V,
  });

  it('fits the ellipsoid from its outline drawn on three tilted planes', () => {
    const p: V = [25, 23, 24];
    const axes: [V, V][] = [
      // Axial tilted 30° about x; coronal turned 25° about z; sagittal tilted 20° about y.
      [[1, 0, 0], turn([0, 1, 0], 0, 30)],
      [turn([1, 0, 0], 2, 25), [0, 0, 1]],
      [[0, 1, 0], turn([0, 0, 1], 1, 20)],
    ];
    const label = { dims, spacing, data: new Uint16Array(N ** 3) };
    const planes = axes.map(([e1, e2]) => {
      const plane = through(p, e1, e2);
      // The ellipsoid's edge on the plane, found outward from `p` along each direction.
      const loop = Array.from({ length: 120 }, (_, i): PlanePoint => {
        const angle = (2 * Math.PI * i) / 120;
        const d = [0, 1, 2].map((k) => Math.cos(angle) * e1[k] + Math.sin(angle) * e2[k]);
        let r = 0;
        while (inside(p[0] + (r + 0.02) * d[0], p[1] + (r + 0.02) * d[1], p[2] + (r + 0.02) * d[2]))
          r += 0.02;
        return [32 + r * Math.cos(angle), 32 + r * Math.sin(angle)];
      });
      for (const index of fillPlaneLoop(dims, spacing, plane, loop)) label.data[index] = 5;
      return plane;
    });
    const truth = new Uint8Array(N ** 3);
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) truth[labelIndex(dims, x, y, z)] = inside(x, y, z) ? 1 : 0;
      }
    }
    const fitted = fitFromContours(
      label,
      planes.map((plane) => sectionOf(label, 5, plane)),
    );
    // The ellipsoid's own sections on the same planes, fitted: what drawing them is held to.
    const whole = { dims, spacing, data: Uint16Array.from(truth, (v) => v * 5) };
    const own = fitFromContours(
      whole,
      planes.map((plane) => sectionOf(whole, 5, plane)),
    );
    expect(dice(fitted, truth)).toBeGreaterThan(0.945);
    expect(dice(own, truth) - dice(fitted, truth)).toBeLessThan(0.01);
  });
});

describe('the image on a plane (#303)', () => {
  const dims: V = [6, 5, 4];
  const image = Float32Array.from({ length: 6 * 5 * 4 }, (_, i) => {
    const [x, y, z] = [i % 6, Math.floor(i / 6) % 5, Math.floor(i / 30)];
    return 3 * x + 7 * y + 11 * z;
  });

  it('is the slice, on a slice of the grid', () => {
    const picture = planeImage(image, dims, [1, 1, 1], {
      origin: [-0.5, -0.5, 2],
      alongU: [6, 0, 0],
      alongV: [0, 5, 0],
    })!;
    const slice = slicePlane(image, dims, 2, 2);
    expect([picture.width, picture.height]).toEqual([slice.width, slice.height]);
    expect(picture.pixelMm).toEqual([1, 1]);
    expect([...picture.data]).toEqual([...slice.data]);
  });

  it('is between the voxels on a tilted plane, and the grid’s face beyond it', () => {
    // Along x, and along (0, 1, 1)/√2: through (0, 0, 0) and (0, 3, 3).
    const picture = planeImage(image, dims, [1, 1, 1], {
      origin: [0, 0, 0],
      alongU: [5, 0, 0],
      alongV: [0, 3, 3],
    })!;
    expect([picture.width, picture.height]).toEqual([5, 4]);
    const stepV = Math.hypot(3, 3) / 4;
    expect(picture.pixelMm[0]).toBeCloseTo(1, 12);
    expect(picture.pixelMm[1]).toBeCloseTo(stepV, 12);
    // The image is linear in the voxel: a pixel holds its value at its centre.
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 5; column++) {
        const [x, t] = [column + 0.5, ((row + 0.5) * stepV) / Math.SQRT2];
        expect(picture.data[row * 5 + column]).toBeCloseTo(3 * x + 7 * t + 11 * t, 4);
      }
    }
    // Beyond the grid: the value at its nearest face, not nothing.
    const beyond = planeImage(image, dims, [1, 1, 1], {
      origin: [-0.5, -0.5, 9],
      alongU: [6, 0, 0],
      alongV: [0, 5, 0],
    })!;
    expect([...beyond.data]).toEqual([...slicePlane(image, dims, 2, 3).data]);
    expect(
      planeImage(image, dims, [1, 1, 1], {
        origin: [0, 0, 0],
        alongU: [0, 0, 0],
        alongV: [0, 1, 0],
      }),
    ).toBeNull();
  });
});

describe('a plane’s picture and the voxels of its sheet (#307)', () => {
  const dims: V = [40, 40, 24];
  const spacing: V = [1, 1, 2];
  const along: V = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const tilted: PlaneSpan = {
    origin: [0, 20 - 20 * along[1], 12 - (20 * along[2]) / 2],
    alongU: [40, 0, 0],
    alongV: [0, 40 * along[1], (40 * along[2]) / 2],
  };

  it('lays a picture out as the section and the image are laid', () => {
    const raster = planeRaster(tilted, spacing)!;
    const label = { dims, spacing, data: new Uint16Array(40 * 40 * 24) };
    const section = sectionOf(label, 5, tilted);
    const picture = planeImage(new Float32Array(40 * 40 * 24), dims, spacing, tilted)!;
    expect([raster.width, raster.height]).toEqual([40, 40]);
    expect([section.width, section.height]).toEqual([raster.width, raster.height]);
    expect([picture.width, picture.height]).toEqual([raster.width, raster.height]);
    expect(picture.pixelMm).toEqual(raster.pixelMm);
    expect(planeRaster({ ...tilted, alongU: [0, 0, 0] }, spacing)).toBeNull();
  });

  it('gives a slice of the grid its own voxels, each to its own pixel', () => {
    const axial: PlaneSpan = { origin: [-0.5, -0.5, 7], alongU: [40, 0, 0], alongV: [0, 40, 0] };
    const raster = planeRaster(axial, spacing)!;
    const { voxels, pixels } = sheetVoxels(dims, spacing, axial, raster);
    expect(voxels).toHaveLength(1600);
    for (let n = 0; n < voxels.length; n++) {
      const [x, y, z] = [
        voxels[n] % 40,
        Math.floor(voxels[n] / 40) % 40,
        Math.floor(voxels[n] / 1600),
      ];
      expect(z).toBe(7);
      expect(pixels[n]).toBe(y * 40 + x);
    }
  });

  it('gives a tilted plane every voxel of its sheet once, each to the pixel its foot is in', () => {
    const raster = planeRaster(tilted, spacing)!;
    const { voxels, pixels } = sheetVoxels(dims, spacing, tilted, raster);
    const { normal, offsetMm } = gridPlaneOf(tilted, spacing)!;
    const half = sheetHalfMm(normal, spacing);
    expect(new Set(voxels).size).toBe(voxels.length);
    for (let n = 0; n < voxels.length; n++) {
      const voxel: V = [
        voxels[n] % 40,
        Math.floor(voxels[n] / 40) % 40,
        Math.floor(voxels[n] / 1600),
      ];
      const [a, b] = planePointMm(tilted, spacing, voxel)!;
      expect(pixels[n]).toBe(
        Math.floor(b / raster.pixelMm[1]) * raster.width + Math.floor(a / raster.pixelMm[0]),
      );
    }
    // None of the sheet within the picture is left out: counted the long way.
    let count = 0;
    for (let z = 0; z < 24; z++) {
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
          if (Math.abs(normal[0] * x + normal[1] * y + normal[2] * z * 2 - offsetMm) > half)
            continue;
          const [a, b] = planePointMm(tilted, spacing, [x, y, z])!;
          if (a >= 0 && a <= 40 && b >= 0 && b <= 40) count++;
        }
      }
    }
    expect(voxels).toHaveLength(count);
    // The whole picture's worth, painted, is what a curve round the picture fills.
    const all = fillPlaneLoop(dims, spacing, tilted, [
      [-1e-6, -1e-6],
      [40 + 1e-6, -1e-6],
      [40 + 1e-6, 40 + 1e-6],
      [-1e-6, 40 + 1e-6],
    ]);
    expect([...voxels].sort((p, q) => p - q)).toEqual(all);
  });
});

describe('a round brush’s stroke in a picture (#307)', () => {
  const raster = { width: 20, height: 12, pixelMm: [1, 2] as const };
  const at = (index: number): [number, number] => [index % 20, Math.floor(index / 20)];

  it('covers a disc in mm for a click, the pixel under it whatever the radius', () => {
    const disc = strokePixels(raster, [10, 6], [10, 6], 3).map(at);
    // 3 mm: three pixels either way across, one either way down (pixels 2 mm high).
    expect(disc).toContainEqual([13, 6]);
    expect(disc).toContainEqual([7, 6]);
    expect(disc).toContainEqual([10, 7]);
    expect(disc).not.toContainEqual([14, 6]);
    expect(disc).not.toContainEqual([10, 8]);
    for (const [u, v] of disc) expect(Math.hypot(u - 10, (v - 6) * 2)).toBeLessThanOrEqual(3);
    expect(strokePixels(raster, [10.4, 5.6], [10.4, 5.6], 0).map(at)).toEqual([[10, 6]]);
  });

  it('covers the whole way from one end to the other, each pixel once, and nothing off the picture', () => {
    const stroke = strokePixels(raster, [2, 2], [17, 9], 1.5);
    expect(new Set(stroke).size).toBe(stroke.length);
    const cells = stroke.map(at);
    // A pixel on the line midway, and none far from it.
    expect(cells).toContainEqual([9, 5]);
    expect(cells).toContainEqual([2, 2]);
    expect(cells).toContainEqual([17, 9]);
    expect(cells).not.toContainEqual([2, 9]);
    const off = strokePixels(raster, [-5, -5], [1, 1], 2).map(at);
    expect(off.length).toBeGreaterThan(0);
    expect(off.every(([u, v]) => u >= 0 && v >= 0 && u < 20 && v < 12)).toBe(true);
    expect(strokePixels(raster, [-9, -9], [-9, -9], 1)).toEqual([]);
  });
});
