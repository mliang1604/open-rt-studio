/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Drawing on a tilted plane through the grid (#303): what the tools that
// fill a closed curve (points, live wire) need when the pane they draw on is
// oblique, so that the curve is filled on the plane the pane shows and not
// on the grid's slices.
//
// **The plane's own coordinates** are millimetres along its two axes from
// its origin (a `PlaneSpan`'s corner): the curve is kept and filled in them,
// so that it is the shape the pane shows whatever the voxels' spacing.
//
// **Filling** takes the voxels whose centres are within half their extent
// along the plane's normal of the plane (a sheet a voxel thick, the same
// sheet the disc brush paints on a tilted pane) and whose foot on the plane
// is within the curve (even-odd).
//
// **The image on the plane**, for the live wire, is sampled a pixel of the
// grid's finest spacing apart, between the voxels about each pixel.

import type { SlicePlane } from './live-wire.js';
import type { PlanePoint } from './polygon-spline.js';
import type { PlaneSpan } from './surface-fit.js';
import type { Vec3 } from './types.js';

/**
 * A plane in millimetres of the grid (a voxel's index times the spacing):
 * the points `p` with `normal · p = offsetMm`; `normal` of length 1.
 */
export interface GridPlane {
  readonly normal: Vec3;
  readonly offsetMm: number;
}

/** A plane's origin, its two axes and its normal, in mm of the grid; the axes and the normal of length 1. */
interface PlaneAxes {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  /** How long the span is along each axis, in mm. */
  readonly lengthU: number;
  readonly lengthV: number;
}

const scaled = (a: Vec3, s: Vec3): Vec3 => [a[0] * s[0], a[1] * s[1], a[2] * s[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));

/** Null for a span with no area. The span's two axes are taken as at right angles in mm, as a pane's are. */
function axesOf(plane: PlaneSpan, spacing: Vec3): PlaneAxes | null {
  const alongU = scaled(plane.alongU, spacing);
  const alongV = scaled(plane.alongV, spacing);
  const [lengthU, lengthV] = [length(alongU), length(alongV)];
  if (!(lengthU > 0) || !(lengthV > 0)) return null;
  const u: Vec3 = [alongU[0] / lengthU, alongU[1] / lengthU, alongU[2] / lengthU];
  const v: Vec3 = [alongV[0] / lengthV, alongV[1] / lengthV, alongV[2] / lengthV];
  const cross: Vec3 = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const size = length(cross);
  if (!(size > 0)) return null;
  return {
    origin: scaled(plane.origin, spacing),
    u,
    v,
    normal: [cross[0] / size, cross[1] / size, cross[2] / size],
    lengthU,
    lengthV,
  };
}

/** A span of the grid as a plane in mm of the grid; null for a span with no area. */
export function gridPlaneOf(plane: PlaneSpan, spacing: Vec3): GridPlane | null {
  const axes = axesOf(plane, spacing);
  return axes ? { normal: axes.normal, offsetMm: dot(axes.normal, axes.origin) } : null;
}

/** Whether two planes are one: the same normal (either way round) and offset, to a thousandth of a mm. */
export function sameGridPlane(a: GridPlane, b: GridPlane): boolean {
  const along = dot(a.normal, b.normal);
  return Math.abs(along) > 1 - 1e-9 && Math.abs(a.offsetMm - Math.sign(along) * b.offsetMm) < 1e-3;
}

/**
 * Half a voxel's extent along a plane's normal, in mm: a voxel whose centre
 * is no farther than this from the plane is on its sheet.
 */
export function sheetHalfMm(normal: Vec3, spacing: Vec3): number {
  return (
    0.5 *
    (Math.abs(normal[0]) * spacing[0] +
      Math.abs(normal[1]) * spacing[1] +
      Math.abs(normal[2]) * spacing[2])
  );
}

/**
 * Where a point of the grid (a continuous voxel) is on a plane, in mm along
 * the plane's two axes from its origin: its foot, for a point off the plane.
 * Null for a span with no area.
 */
export function planePointMm(plane: PlaneSpan, spacing: Vec3, voxel: Vec3): PlanePoint | null {
  const axes = axesOf(plane, spacing);
  if (!axes) return null;
  const at = scaled(voxel, spacing);
  const from: Vec3 = [at[0] - axes.origin[0], at[1] - axes.origin[1], at[2] - axes.origin[2]];
  return [dot(from, axes.u), dot(from, axes.v)];
}

/** The continuous voxel at a point of a plane, given in mm along its two axes; null for a span with no area. */
export function planeVoxelAt(plane: PlaneSpan, spacing: Vec3, point: PlanePoint): Vec3 | null {
  const axes = axesOf(plane, spacing);
  if (!axes) return null;
  return [0, 1, 2].map(
    (k) => (axes.origin[k] + point[0] * axes.u[k] + point[1] * axes.v[k]) / spacing[k],
  ) as unknown as Vec3;
}

/**
 * Every voxel of the grid on a plane's sheet whose foot on the plane is
 * within a rectangle of it, `[aLo, aHi, bLo, bHi]` in mm along the plane's
 * two axes, ends included: its flat index, and where its foot is.
 */
function eachSheetVoxel(
  dims: readonly [number, number, number],
  spacing: Vec3,
  axes: PlaneAxes,
  [aLo, aHi, bLo, bHi]: readonly [number, number, number, number],
  visit: (index: number, a: number, b: number) => void,
): void {
  const { origin, u, v, normal } = axes;
  const offsetMm = dot(normal, origin);
  const half = sheetHalfMm(normal, spacing);

  // Step through the two axes the plane lies along most, and solve for the third.
  const weight = [0, 1, 2].map((k) => Math.abs(normal[k]) * spacing[k]);
  const k = weight.indexOf(Math.max(...weight)) as 0 | 1 | 2;
  const [i, j] = ([0, 1, 2] as const).filter((axis) => axis !== k);
  const perStep = normal[k] * spacing[k];

  // The rectangle's reach along those two axes, in voxels.
  let [iLo, iHi, jLo, jHi] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [a, b] of [
    [aLo, bLo],
    [aHi, bLo],
    [aLo, bHi],
    [aHi, bHi],
  ]) {
    const atI = (origin[i] + a * u[i] + b * v[i]) / spacing[i];
    const atJ = (origin[j] + a * u[j] + b * v[j]) / spacing[j];
    [iLo, iHi] = [Math.min(iLo, atI), Math.max(iHi, atI)];
    [jLo, jHi] = [Math.min(jLo, atJ), Math.max(jHi, atJ)];
  }
  const [i0, i1] = [Math.max(0, Math.floor(iLo) - 1), Math.min(dims[i] - 1, Math.ceil(iHi) + 1)];
  const [j0, j1] = [Math.max(0, Math.floor(jLo) - 1), Math.min(dims[j] - 1, Math.ceil(jHi) + 1)];

  const [nx, ny] = dims;
  const at: [number, number, number] = [0, 0, 0];
  for (at[j] = j0; at[j] <= j1; at[j]++) {
    for (at[i] = i0; at[i] <= i1; at[i]++) {
      // Along the third axis, the few voxels about where the plane crosses this column.
      const rest = normal[i] * at[i] * spacing[i] + normal[j] * at[j] * spacing[j] - offsetMm;
      const [from, to] = [(-half - rest) / perStep, (half - rest) / perStep];
      const k0 = Math.max(0, Math.ceil(Math.min(from, to)) - 1);
      const k1 = Math.min(dims[k] - 1, Math.floor(Math.max(from, to)) + 1);
      for (at[k] = k0; at[k] <= k1; at[k]++) {
        const mm: Vec3 = [at[0] * spacing[0], at[1] * spacing[1], at[2] * spacing[2]];
        // The disc brush's test of its sheet, word for word (`stampVoxels`).
        if (Math.abs(dot(normal, mm) - offsetMm) > half) continue;
        const off: Vec3 = [mm[0] - origin[0], mm[1] - origin[1], mm[2] - origin[2]];
        const [a, b] = [dot(off, u), dot(off, v)];
        if (a < aLo || a > aHi || b < bLo || b > bHi) continue;
        visit((at[2] * ny + at[1]) * nx + at[0], a, b);
      }
    }
  }
}

/**
 * The voxels of a grid within a closed loop on a plane through it: those on
 * the plane's sheet whose foot on the plane is within the loop. The loop is
 * in mm along the plane's two axes from its origin (`planePointMm`). Flat
 * indices, in order.
 */
export function fillPlaneLoop(
  dims: readonly [number, number, number],
  spacing: Vec3,
  plane: PlaneSpan,
  loop: readonly PlanePoint[],
): number[] {
  const axes = axesOf(plane, spacing);
  if (!axes || loop.length < 3) return [];
  let [aLo, aHi, bLo, bHi] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [a, b] of loop) {
    [aLo, aHi] = [Math.min(aLo, a), Math.max(aHi, a)];
    [bLo, bHi] = [Math.min(bLo, b), Math.max(bHi, b)];
  }
  if (!Number.isFinite(aLo + aHi + bLo + bHi)) return [];

  const n = loop.length;
  /** Even-odd, a vertex on the line counted for one of its two edges, as `fillLoops` counts. */
  const within = (a: number, b: number): boolean => {
    let inside = false;
    for (let e = 0; e < n; e++) {
      const p = loop[e];
      const q = loop[e + 1 === n ? 0 : e + 1];
      if (p[1] <= b !== q[1] <= b && p[0] + ((b - p[1]) / (q[1] - p[1])) * (q[0] - p[0]) <= a) {
        inside = !inside;
      }
    }
    return inside;
  };

  const voxels: number[] = [];
  eachSheetVoxel(dims, spacing, axes, [aLo, aHi, bLo, bHi], (index, a, b) => {
    if (within(a, b)) voxels.push(index);
  });
  return voxels.sort((p, q) => p - q);
}

/**
 * How a plane is laid out as a picture: how many pixels across and down, and
 * a pixel's width and height in mm. Pixel (u, v)'s middle is at
 * ((u + ½)·width, (v + ½)·height) mm along the plane's two axes.
 */
export interface PlaneRaster {
  readonly width: number;
  readonly height: number;
  readonly pixelMm: readonly [number, number];
}

function rasterOf(axes: PlaneAxes, pixelMm: number): PlaneRaster {
  const width = Math.max(1, Math.round(axes.lengthU / pixelMm));
  const height = Math.max(1, Math.round(axes.lengthV / pixelMm));
  return { width, height, pixelMm: [axes.lengthU / width, axes.lengthV / height] };
}

/**
 * A plane's picture: its pixels the grid's finest spacing apart (or
 * `pixelMm`), as `sectionOf` and `planeImage` lay them. Null for a span with
 * no area.
 */
export function planeRaster(
  plane: PlaneSpan,
  spacing: Vec3,
  pixelMm = Math.min(...spacing),
): PlaneRaster | null {
  const axes = axesOf(plane, spacing);
  return axes ? rasterOf(axes, pixelMm) : null;
}

/**
 * The voxels of the grid on a plane's sheet, each with the pixel of the
 * plane's picture its foot is in: `voxels[n]` is a flat index of the grid,
 * `pixels[n]` the pixel `v · width + u` it belongs to. What is drawn in the
 * picture is put into the grid through these, and no voxel of the sheet is
 * left out, so the sheet has no holes seen from another plane.
 */
export function sheetVoxels(
  dims: readonly [number, number, number],
  spacing: Vec3,
  plane: PlaneSpan,
  raster: PlaneRaster,
): { readonly voxels: Int32Array; readonly pixels: Int32Array } {
  const axes = axesOf(plane, spacing);
  if (!axes) return { voxels: new Int32Array(0), pixels: new Int32Array(0) };
  const { width, height, pixelMm } = raster;
  const [voxels, pixels]: [number[], number[]] = [[], []];
  eachSheetVoxel(
    dims,
    spacing,
    axes,
    [0, width * pixelMm[0], 0, height * pixelMm[1]],
    (index, a, b) => {
      const u = Math.min(width - 1, Math.floor(a / pixelMm[0]));
      const v = Math.min(height - 1, Math.floor(b / pixelMm[1]));
      voxels.push(index);
      pixels.push(v * width + u);
    },
  );
  return { voxels: Int32Array.from(voxels), pixels: Int32Array.from(pixels) };
}

/**
 * The pixels of a picture a round brush covers from `from` to `to`: those
 * whose middle is within `radiusMm` of the stroke, and the pixel under each
 * end whatever the radius. `from` and `to` are in pixels, a whole number at
 * a pixel's middle. Pixel indices `v · width + u`, each once.
 */
export function strokePixels(
  raster: PlaneRaster,
  from: PlanePoint,
  to: PlanePoint,
  radiusMm: number,
): number[] {
  const { width, height, pixelMm } = raster;
  const [pu, pv] = pixelMm;
  const out = new Set<number>();
  const inside = (u: number, v: number): boolean => u >= 0 && v >= 0 && u < width && v < height;
  for (const [u, v] of [from, to]) {
    const [ru, rv] = [Math.round(u), Math.round(v)];
    if (inside(ru, rv)) out.add(rv * width + ru);
  }
  const r = Math.max(0, radiusMm);
  const [u0, u1] = [
    Math.max(0, Math.floor(Math.min(from[0], to[0]) - r / pu)),
    Math.min(width - 1, Math.ceil(Math.max(from[0], to[0]) + r / pu)),
  ];
  const [v0, v1] = [
    Math.max(0, Math.floor(Math.min(from[1], to[1]) - r / pv)),
    Math.min(height - 1, Math.ceil(Math.max(from[1], to[1]) + r / pv)),
  ];
  // In mm: the stroke's line, and how far each pixel's middle is from it.
  const [ax, ay] = [from[0] * pu, from[1] * pv];
  const [dx, dy] = [to[0] * pu - ax, to[1] * pv - ay];
  const lengthSquared = dx * dx + dy * dy;
  for (let v = v0; v <= v1; v++) {
    for (let u = u0; u <= u1; u++) {
      const [px, py] = [u * pu - ax, v * pv - ay];
      const along =
        lengthSquared > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / lengthSquared)) : 0;
      const [ox, oy] = [px - along * dx, py - along * dy];
      if (ox * ox + oy * oy <= r * r) out.add(v * width + u);
    }
  }
  return [...out];
}

/** The image on a plane through the grid, as a picture, and how large its pixels are. */
export interface PlaneImage extends SlicePlane {
  /** A pixel's width and height in mm: pixel (i, j)'s centre is at ((i + ½)·width, (j + ½)·height) on the plane. */
  readonly pixelMm: readonly [number, number];
}

/**
 * The image's values on a plane through the grid: its pixels the grid's
 * finest spacing apart (or `pixelMm`), as `sectionOf` lays them, each
 * between the eight voxels about its centre. Off the grid, a pixel takes the
 * value at the grid's nearest face, so that the grid's end is no edge. Null
 * for a span with no area.
 */
export function planeImage(
  image: Float32Array,
  dims: readonly [number, number, number],
  spacing: Vec3,
  plane: PlaneSpan,
  pixelMm = Math.min(...spacing),
): PlaneImage | null {
  const axes = axesOf(plane, spacing);
  if (!axes) return null;
  const [nx, ny, nz] = dims;
  const { width, height, pixelMm: steps } = rasterOf(axes, pixelMm);
  const [stepU, stepV] = steps;
  const data = new Float32Array(width * height);
  const clamp = (value: number, most: number): number => Math.min(Math.max(value, 0), most);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const [a, b] = [(column + 0.5) * stepU, (row + 0.5) * stepV];
      const x = clamp((axes.origin[0] + a * axes.u[0] + b * axes.v[0]) / spacing[0], nx - 1);
      const y = clamp((axes.origin[1] + a * axes.u[1] + b * axes.v[1]) / spacing[1], ny - 1);
      const z = clamp((axes.origin[2] + a * axes.u[2] + b * axes.v[2]) / spacing[2], nz - 1);
      const [x0, y0, z0] = [Math.floor(x), Math.floor(y), Math.floor(z)];
      const [x1, y1, z1] = [
        Math.min(x0 + 1, nx - 1),
        Math.min(y0 + 1, ny - 1),
        Math.min(z0 + 1, nz - 1),
      ];
      const [fx, fy, fz] = [x - x0, y - y0, z - z0];
      const value = (xi: number, yi: number, zi: number): number => image[(zi * ny + yi) * nx + xi];
      const along = (yi: number, zi: number): number =>
        value(x0, yi, zi) * (1 - fx) + value(x1, yi, zi) * fx;
      data[row * width + column] =
        (along(y0, z0) * (1 - fy) + along(y1, z0) * fy) * (1 - fz) +
        (along(y0, z1) * (1 - fy) + along(y1, z1) * fy) * fz;
    }
  }
  return { data, width, height, pixelMm: [stepU, stepV] };
}
