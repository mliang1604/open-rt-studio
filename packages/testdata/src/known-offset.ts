/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Two series a known offset apart, for a test of a registration that is
// really computed: by the server's job with the native tool (#80), and by an
// installed desktop application with the tools packed in it (#70). Small, so
// that the registration takes seconds.

import {
  seriesUid,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  type SyntheticFile,
} from './identity.js';
import { writeImageSeries } from './image-series.js';

type Vec3 = [number, number, number];

/** The series of the pair, by their index in their studies. */
const KNOWN_OFFSET_SERIES_INDEX = { fixed: 1, moving: 2 } as const;

/** The SeriesInstanceUIDs of the pair. */
export const KNOWN_OFFSET_SERIES = {
  fixed: seriesUid(SYNTHETIC_STUDY, KNOWN_OFFSET_SERIES_INDEX.fixed),
  moving: seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, KNOWN_OFFSET_SERIES_INDEX.moving),
} as const;

/** What the phantom holds at a point of the fixed image's coordinates, in mm: like CT numbers. */
function phantomAt([x, y, z]: Vec3): number {
  const r = Math.hypot(x / 55, y / 45, z / 38);
  const inside = 1 / (1 + Math.exp((r - 1) * 20));
  const blobs: [height: number, width: number, centre: Vec3][] = [
    [800, 10, [18, 9, 5]],
    [-600, 12, [-25, -12, -14]],
    [500, 8, [4, -28, 16]],
    [300, 14, [-9, 24, -18]],
  ];
  let value = 0;
  for (const [height, width, [cx, cy, cz]] of blobs) {
    const squared = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
    value += height * Math.exp(-squared / (2 * width * width));
  }
  return -1000 + inside * (1000 + value);
}

/**
 * Where a point of the fixed image is in the moving image's coordinates:
 * the moving image's frame is somewhere else altogether, as that of another
 * scanner is.
 */
export const KNOWN_OFFSET: Vec3 = [120.5, -64, 38];
/** The grid of the fixed series: square slices of `size` voxels, `count` of them, in mm. */
export const KNOWN_OFFSET_FIXED = {
  size: 48,
  count: 32,
  pixel: 3,
  slice: 3,
  origin: [-70.5, -70.5, -46.5] as Vec3,
};
/** Another grid, whose middle is (6, -4.5, 5) mm from where the phantom's middle is. */
export const KNOWN_OFFSET_MOVING = {
  size: 44,
  count: 30,
  pixel: 3.2,
  slice: 3.4,
  origin: [
    KNOWN_OFFSET[0] + 6 - 68.8,
    KNOWN_OFFSET[1] - 4.5 - 68.8,
    KNOWN_OFFSET[2] + 5 - 49.3,
  ] as Vec3,
};
/**
 * Two series of one phantom in two frames of reference, a known offset
 * apart: a CT in the planning study and an MR-like series in the follow-up
 * study, on another grid. What a rigid registration of the two should find
 * is {@link KNOWN_OFFSET}; {@link knownOffsetError} says how far off a
 * matrix is.
 */
export function knownOffsetPair(): { fixed: SyntheticFile[]; moving: SyntheticFile[] } {
  const common = { window: [1000, 2000] as const, namePrefix: 'known-offset' };
  const fixed = writeImageSeries({
    ...common,
    modality: 'CT',
    study: SYNTHETIC_STUDY,
    seriesIndex: KNOWN_OFFSET_SERIES_INDEX.fixed,
    description: 'Phantom',
    rows: KNOWN_OFFSET_FIXED.size,
    columns: KNOWN_OFFSET_FIXED.size,
    count: KNOWN_OFFSET_FIXED.count,
    pixelSpacing: KNOWN_OFFSET_FIXED.pixel,
    sliceSpacing: KNOWN_OFFSET_FIXED.slice,
    origin: KNOWN_OFFSET_FIXED.origin,
    stored: (column, row, slice) =>
      Math.round(
        phantomAt([
          KNOWN_OFFSET_FIXED.origin[0] + column * KNOWN_OFFSET_FIXED.pixel,
          KNOWN_OFFSET_FIXED.origin[1] + row * KNOWN_OFFSET_FIXED.pixel,
          KNOWN_OFFSET_FIXED.origin[2] + slice * KNOWN_OFFSET_FIXED.slice,
        ]) + 1000,
      ),
  });
  const moving = writeImageSeries({
    ...common,
    modality: 'MR',
    study: SYNTHETIC_FOLLOW_UP_STUDY,
    seriesIndex: KNOWN_OFFSET_SERIES_INDEX.moving,
    description: 'Phantom, elsewhere',
    rows: KNOWN_OFFSET_MOVING.size,
    columns: KNOWN_OFFSET_MOVING.size,
    count: KNOWN_OFFSET_MOVING.count,
    pixelSpacing: KNOWN_OFFSET_MOVING.pixel,
    sliceSpacing: KNOWN_OFFSET_MOVING.slice,
    origin: KNOWN_OFFSET_MOVING.origin,
    // The same anatomy where the offset puts it, and not in the same grey
    // values: dense is dark here, as an MR is no CT.
    stored: (column, row, slice) =>
      Math.round(
        1500 -
          0.6 *
            (phantomAt([
              KNOWN_OFFSET_MOVING.origin[0] + column * KNOWN_OFFSET_MOVING.pixel - KNOWN_OFFSET[0],
              KNOWN_OFFSET_MOVING.origin[1] + row * KNOWN_OFFSET_MOVING.pixel - KNOWN_OFFSET[1],
              KNOWN_OFFSET_MOVING.origin[2] + slice * KNOWN_OFFSET_MOVING.slice - KNOWN_OFFSET[2],
            ]) +
              1000),
      ),
  });
  return { fixed, moving };
}

/**
 * How far a matrix that maps the fixed image's coordinates to the moving
 * image's (row-major, 4 x 4) is from the known offset, in mm: the most at
 * the eight corners of the fixed image, where a wrong turn shows most.
 */
export function knownOffsetError(fixedToMoving: readonly number[]): number {
  const { origin, size, pixel, count, slice } = KNOWN_OFFSET_FIXED;
  let worst = 0;
  for (let corner = 0; corner < 8; corner++) {
    const at: Vec3 = [
      origin[0] + (corner & 1 ? (size - 1) * pixel : 0),
      origin[1] + (corner & 2 ? (size - 1) * pixel : 0),
      origin[2] + (corner & 4 ? (count - 1) * slice : 0),
    ];
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const found =
        fixedToMoving[4 * axis] * at[0] +
        fixedToMoving[4 * axis + 1] * at[1] +
        fixedToMoving[4 * axis + 2] * at[2] +
        fixedToMoving[4 * axis + 3];
      squared += (found - (at[axis] + KNOWN_OFFSET[axis])) ** 2;
    }
    worst = Math.max(worst, Math.sqrt(squared));
  }
  return worst;
}
