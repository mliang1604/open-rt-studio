/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Runs in the browser, not in the test: `resample-gpu.spec.ts` bundles this
// file and puts it in a page, where it resamples the same synthetic image
// through the same registration by the reference (`resampleVolume`) and on
// the GPU (`resampleOnGpu`), and says how far apart the two results are and
// how far each is from the analytic answer. The resampling engine (#88) has
// no screen of its own yet, so this is how it meets a real GPU.

import {
  IDENTITY_MAT4,
  invertMat4,
  patientToVoxel,
  pointToLayer,
  resampleVolume,
  rigidMat4,
  sumDoses,
  type DeformationGrid,
  type DoseSumTerm,
  type Interpolation,
  type LayerPlacement,
  type Mat4,
  type ResampleGrid,
  type Vec3,
} from '@open-rt-studio/dicom';
import { resample, resampleOnGpu, sumDosesWith } from '@open-rt-studio/render';

type Dims = [number, number, number];

/** A grid as the test describes it: plain numbers that cross into the page. */
export interface HarnessGrid {
  readonly dims: Dims;
  readonly spacing: Vec3;
  readonly origin: Vec3;
  /** A turn of the grid's axes about an axis, in degrees; none when left out. */
  readonly turn?: { readonly axis: Vec3; readonly degrees: number };
}

export interface HarnessCase {
  readonly source: HarnessGrid;
  /**
   * What the source holds. `ramp` goes evenly with the voxel index, so
   * blending gives it exactly and the answer has a formula. `blob` curves, so
   * the two ways must blend alike to agree. `labels` are whole numbers.
   */
  readonly values: 'ramp' | 'blob' | 'labels';
  readonly reference: HarnessGrid;
  /** The matrix from the reference's frame to the source's: a turn and a shift. */
  readonly matrix?: { readonly axis: Vec3; readonly degrees: number; readonly shift: Vec3 };
  /**
   * A deformation field before that matrix. `even` goes evenly with the
   * place (read exactly between vectors); `wave` curves. `holes` makes some
   * vectors undefined.
   */
  readonly field?: {
    readonly grid: HarnessGrid;
    readonly kind: 'even' | 'wave';
    readonly holes?: boolean;
  };
  readonly interpolation: Interpolation;
  /** The most bytes of the result worked out at once: small, to make many slabs. */
  readonly maxSlabBytes?: number;
}

export interface HarnessResult {
  readonly voxels: number;
  /** Voxels that have a value both ways, and the most the two values differ by. */
  readonly both: number;
  readonly maxDifference: number;
  /** Voxels that have a value one way and are outside the other. */
  readonly disagreeOutside: number;
  /** Voxels whose two values are not the same number at all. */
  readonly different: number;
  readonly outsideCpu: number;
  readonly outsideGpu: number;
  /** For a ramp: the most each way is from the formula. Null for other values. */
  readonly maxFromFormulaCpu: number | null;
  readonly maxFromFormulaGpu: number | null;
  /** The largest and smallest value of the source, to judge a difference against. */
  readonly range: number;
  readonly cpuMs: number;
  readonly gpuMs: number;
  /** What `resample` said it used, and why not the GPU when it did not. */
  readonly by: string;
  readonly gpuProblem: string | null;
  /**
   * Whether `resample`, which works the result out in slabs of its own
   * choosing, gave the very numbers `resampleOnGpu` gave in the slabs the
   * case asked for: the result does not depend on how it is cut up.
   */
  readonly sameHoweverCut: boolean;
}

const OUTSIDE = -4096;
const RAMP = [3, -2, 5, 100] as const;
const rampAt = ([x, y, z]: Vec3): number => RAMP[0] * x + RAMP[1] * y + RAMP[2] * z + RAMP[3];

function gridOf(
  grid: HarnessGrid,
): ResampleGrid & { geometry: NonNullable<ResampleGrid['geometry']> } {
  const turn: Mat4 = grid.turn ? rigidMat4(grid.turn.axis, grid.turn.degrees) : IDENTITY_MAT4;
  const step = (axis: number): Vec3 => [
    turn[axis] * grid.spacing[axis],
    turn[4 + axis] * grid.spacing[axis],
    turn[8 + axis] * grid.spacing[axis],
  ];
  return {
    dims: grid.dims,
    spacing: grid.spacing,
    geometry: { iStep: step(0), jStep: step(1), kStep: step(2), origin: grid.origin },
  };
}

function valuesOf(kind: HarnessCase['values'], dims: Dims): Float32Array {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        if (kind === 'ramp') data[at] = rampAt([i, j, k]);
        else if (kind === 'labels') data[at] = (i >> 2) + 16 * (j >> 2) + 256 * (k >> 1);
        else {
          // A bright ball off the middle, on a slope, with ripples: nothing even about it.
          const r2 = (i - nx * 0.4) ** 2 + (j - ny * 0.55) ** 2 + ((k - nz * 0.5) * 2) ** 2;
          data[at] =
            1000 * Math.exp(-r2 / (0.08 * nx * nx)) + 4 * i - 3 * j + 40 * Math.sin(i * 0.9 + k);
        }
      }
    }
  }
  return data;
}

function fieldOf(field: NonNullable<HarnessCase['field']>): DeformationGrid {
  const { dims, spacing, origin } = field.grid;
  const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
  let at = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++, at += 3) {
        const [x, y, z] = [
          origin[0] + i * spacing[0],
          origin[1] + j * spacing[1],
          origin[2] + k * spacing[2],
        ];
        const moved: Vec3 =
          field.kind === 'even'
            ? [0.1 * x + 1, -0.05 * y + 0.02 * z, 0.5 - 0.03 * x]
            : [
                2 * Math.sin(y * 0.3),
                1.5 * Math.cos(x * 0.25 + z * 0.1),
                Math.sin(x * 0.2) * Math.cos(y * 0.2),
              ];
        vectors.set(moved, at);
        if (field.holes && (i + 2 * j + 3 * k) % 11 === 0) vectors.fill(Number.NaN, at, at + 3);
      }
    }
  }
  return {
    dims,
    origin,
    spacing,
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    vectors,
  };
}

let devicePromise: Promise<GPUDevice> | null = null;
function gpuDevice(): Promise<GPUDevice> {
  devicePromise ??= (async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter.');
    return adapter.requestDevice();
  })();
  return devicePromise;
}

async function run(spec: HarnessCase): Promise<HarnessResult> {
  const sourceGrid = gridOf(spec.source);
  const reference = gridOf(spec.reference);
  const data = valuesOf(spec.values, spec.source.dims);
  const source = { ...sourceGrid, data };
  const matrix: Mat4 = spec.matrix
    ? rigidMat4(spec.matrix.axis, spec.matrix.degrees, spec.matrix.shift)
    : IDENTITY_MAT4;
  const placement = {
    baseFrame: 'reference',
    layerFrame: 'source',
    steps: [],
    baseToLayer: matrix,
    layerToBase: invertMat4(matrix),
    ...(spec.field
      ? { field: { pre: IDENTITY_MAT4, grid: fieldOf(spec.field), post: matrix } }
      : {}),
  } as LayerPlacement;
  const options = { interpolation: spec.interpolation, outside: OUTSIDE };

  const device = await gpuDevice();
  let started = performance.now();
  const cpu = resampleVolume(source, reference, placement, options);
  const cpuMs = performance.now() - started;
  started = performance.now();
  const gpu = await resampleOnGpu(device, source, reference, placement, options, spec.maxSlabBytes);
  const gpuMs = performance.now() - started;
  // The way a caller asks, which must say it used the GPU and give the same.
  const asked = await resample(device, source, reference, placement, options);
  const sameHoweverCut =
    asked.outsideCount === gpu.outsideCount &&
    asked.data.every((value, at) => Object.is(value, gpu.data[at]));

  let [both, maxDifference, disagreeOutside, different] = [0, 0, 0, 0];
  let [fromCpu, fromGpu] = [0, 0];
  let [min, max] = [Infinity, -Infinity];
  for (const value of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const [nx, ny, nz] = spec.reference.dims;
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        const [a, b] = [cpu.data[at], gpu.data[at]];
        if (a !== b) different++;
        if ((a === OUTSIDE) !== (b === OUTSIDE)) {
          disagreeOutside++;
          continue;
        }
        if (a === OUTSIDE) continue;
        both++;
        maxDifference = Math.max(maxDifference, Math.abs(a - b));
        if (spec.values !== 'ramp' || spec.interpolation !== 'linear') continue;
        // The formula: where the placement puts the voxel, held to the source's voxel centres.
        const { iStep, jStep, kStep, origin } = reference.geometry;
        const point: Vec3 = [
          origin[0] + i * iStep[0] + j * jStep[0] + k * kStep[0],
          origin[1] + i * iStep[1] + j * jStep[1] + k * kStep[1],
          origin[2] + i * iStep[2] + j * jStep[2] + k * kStep[2],
        ];
        const placed = pointToLayer(placement, point);
        const index = placed && patientToVoxel(sourceGrid.geometry, placed);
        if (!index) continue;
        const held = index.map((value, axis) =>
          Math.min(Math.max(value, 0), spec.source.dims[axis] - 1),
        ) as unknown as Vec3;
        fromCpu = Math.max(fromCpu, Math.abs(a - rampAt(held)));
        fromGpu = Math.max(fromGpu, Math.abs(b - rampAt(held)));
      }
    }
  }
  const formula = spec.values === 'ramp' && spec.interpolation === 'linear';
  return {
    voxels: nx * ny * nz,
    both,
    maxDifference,
    disagreeOutside,
    different,
    outsideCpu: cpu.outsideCount,
    outsideGpu: gpu.outsideCount,
    maxFromFormulaCpu: formula ? fromCpu : null,
    maxFromFormulaGpu: formula ? fromGpu : null,
    range: max - min,
    cpuMs,
    gpuMs,
    by: asked.by,
    gpuProblem: asked.gpuProblem,
    sameHoweverCut,
  };
}

/**
 * What is done with an image this GPU cannot hold: one voxel wider than its
 * largest 3-D texture. The reference's result must come, and the reason.
 */
async function runPastTheGpu(): Promise<{
  readonly by: string;
  readonly gpuProblem: string | null;
  readonly same: boolean;
  readonly limit: number;
}> {
  const device = await gpuDevice();
  const limit = device.limits.maxTextureDimension3D;
  const dims: Dims = [limit + 1, 2, 2];
  const grid = gridOf({ dims, spacing: [1, 1, 1], origin: [0, 0, 0] });
  const source = { ...grid, data: valuesOf('ramp', dims) };
  const reference = gridOf({ dims: [8, 2, 2], spacing: [1, 1, 1], origin: [limit - 6.5, 0, 0] });
  const options = { interpolation: 'linear', outside: OUTSIDE } as const;
  const asked = await resample(device, source, reference, null, options);
  const cpu = resampleVolume(source, reference, null, options);
  return {
    by: asked.by,
    gpuProblem: asked.gpuProblem,
    same:
      asked.outsideCount === cpu.outsideCount &&
      asked.data.every((value, at) => value === cpu.data[at]),
    limit,
  };
}

/** Two doses to sum on a grid, as the test describes them (#98). */
export interface SumCase {
  /** The grid the doses are summed on. */
  readonly reference: HarnessGrid;
  /** A dose in the reference's own frame. Both doses go evenly with the voxel (`ramp`). */
  readonly first: HarnessGrid;
  /** A dose in a frame of its own, placed by the matrix, and by the field before it. */
  readonly second: HarnessGrid;
  readonly matrix: NonNullable<HarnessCase['matrix']>;
  readonly field?: NonNullable<HarnessCase['field']>;
  readonly weights: readonly [number, number];
  /** Whether the second dose is said to be nothing beyond its grid. */
  readonly secondIsNothingBeyond?: boolean;
}

export interface SumResult {
  readonly voxels: number;
  /** Voxels where the sum is known, each way; and voxels where only one way knows it. */
  readonly knownCpu: number;
  readonly knownGpu: number;
  readonly disagreeKnown: number;
  /** The most the two sums differ by where both are known. */
  readonly maxDifference: number;
  /** The most each is from the formula, away from the very edge of a dose's grid. */
  readonly maxFromFormulaCpu: number;
  readonly maxFromFormulaGpu: number;
  /** How many voxels were held against the formula. */
  readonly againstFormula: number;
  /** The largest sum, to judge a difference against. */
  readonly range: number;
  /** Which way each dose was resampled, and whether the counts of each term are the same. */
  readonly by: readonly (string | null)[];
  readonly sameCounts: boolean;
  /** Voxels where the second dose was taken to be nothing, by the reference. */
  readonly nothing: number;
}

/**
 * Sum two doses by the reference (`sumDoses`) and with the GPU
 * (`sumDosesWith`), and say how far apart the sums are and how far each is
 * from the formula: the first dose's ramp at the voxel, and the second's at
 * the place the placement takes the voxel to, each times its weight.
 */
async function runSum(spec: SumCase): Promise<SumResult> {
  const reference = gridOf(spec.reference);
  const [firstGrid, secondGrid] = [gridOf(spec.first), gridOf(spec.second)];
  const matrix: Mat4 = rigidMat4(spec.matrix.axis, spec.matrix.degrees, spec.matrix.shift);
  const placement = {
    baseFrame: 'reference',
    layerFrame: 'second',
    steps: [],
    baseToLayer: matrix,
    layerToBase: invertMat4(matrix),
    ...(spec.field
      ? { field: { pre: IDENTITY_MAT4, grid: fieldOf(spec.field), post: matrix } }
      : {}),
  } as LayerPlacement;
  const terms: DoseSumTerm[] = [
    {
      dose: { ...firstGrid, data: valuesOf('ramp', spec.first.dims) },
      through: null,
      weight: spec.weights[0],
    },
    {
      dose: { ...secondGrid, data: valuesOf('ramp', spec.second.dims) },
      through: placement,
      weight: spec.weights[1],
      ...(spec.secondIsNothingBeyond ? { beyondGrid: 'nothing' as const } : {}),
    },
  ];
  const cpu = sumDoses(reference, terms);
  const gpu = await sumDosesWith(await gpuDevice(), reference, terms);

  /** A dose's ramp at a place: null outside its grid, or within a hair of its edge. */
  const rampIn = (grid: HarnessGrid, place: Vec3): number | 'beyond' | 'edge' => {
    const index = patientToVoxel(gridOf(grid).geometry, place)!;
    const margin = Math.min(
      ...index.map((value, axis) => Math.min(value + 0.5, grid.dims[axis] - 0.5 - value)),
    );
    if (Math.abs(margin) < 1e-3) return 'edge';
    if (margin < 0) return 'beyond';
    const held = index.map((value, axis) => Math.min(Math.max(value, 0), grid.dims[axis] - 1));
    return rampAt(held as unknown as Vec3);
  };
  let [disagreeKnown, maxDifference, fromCpu, fromGpu, againstFormula, range] = [0, 0, 0, 0, 0, 0];
  const [nx, ny, nz] = spec.reference.dims;
  const { iStep, jStep, kStep, origin } = reference.geometry;
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        if (cpu.known[at] !== gpu.known[at]) {
          disagreeKnown++;
          continue;
        }
        if (!cpu.known[at]) continue;
        const [a, b] = [cpu.data[at], gpu.data[at]];
        maxDifference = Math.max(maxDifference, Math.abs(a - b));
        range = Math.max(range, Math.abs(a));
        const point: Vec3 = [
          origin[0] + i * iStep[0] + j * jStep[0] + k * kStep[0],
          origin[1] + i * iStep[1] + j * jStep[1] + k * kStep[1],
          origin[2] + i * iStep[2] + j * jStep[2] + k * kStep[2],
        ];
        const one = rampIn(spec.first, point);
        const placed = pointToLayer(placement, point);
        const two = placed ? rampIn(spec.second, placed) : 'edge';
        if (typeof one !== 'number' || two === 'edge') continue;
        // Known, and beyond the second dose's grid: it was said to be nothing there.
        const formula = spec.weights[0] * one + spec.weights[1] * (two === 'beyond' ? 0 : two);
        againstFormula++;
        fromCpu = Math.max(fromCpu, Math.abs(a - formula));
        fromGpu = Math.max(fromGpu, Math.abs(b - formula));
      }
    }
  }
  return {
    voxels: nx * ny * nz,
    knownCpu: cpu.knownCount,
    knownGpu: gpu.knownCount,
    disagreeKnown,
    maxDifference,
    maxFromFormulaCpu: fromCpu,
    maxFromFormulaGpu: fromGpu,
    againstFormula,
    range,
    by: gpu.by,
    sameCounts: JSON.stringify(gpu.terms) === JSON.stringify(cpu.terms),
    nothing: cpu.terms[1].nothing,
  };
}

const harness = { run, runPastTheGpu, runSum };
export type ResampleHarness = typeof harness;
(globalThis as unknown as { resampleHarness: ResampleHarness }).resampleHarness = harness;
