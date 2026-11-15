/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Doses that are formulas, for the dose validation suite (#103): what a
// dose is at any place is known, so what a dose that was mapped, summed or
// converted should be is known too, and is not another run of the same
// code. Not DICOM, and nothing of a patient: numbers of gray on grids.
//
// The image the doses are summed on, and the transforms they are taken
// through, are the resampling phantom's (`resampling-phantom.ts`).

import { phantomGrid } from './resampling-phantom.js';

type Triple = readonly [number, number, number];

export const DOSE_PHANTOM = {
  /**
   * A dose grid in the image's own frame of reference: voxels of 2.5 mm,
   * set off from the image's, and smaller than the image, as a planning
   * system's dose grid is.
   */
  own: phantomGrid([25, 25, 31], [2.5, 2.5, 2.5], [-30.4, -29.7, -37.9]),
  /** A dose grid in another frame of reference: voxels of 3 mm. */
  other: phantomGrid([24, 24, 24], [3, 3, 3], [-34.1, -35.2, -33.3]),
  /** Two doses that are the same everywhere, in gray. */
  uniform: { first: 50, second: 20 },
  /** The linear dose: its value at the origin, and what it gains in a millimetre along x, y and z. */
  linear: { at0: 40, perMm: [0.3, -0.2, 0.4] as Triple },
  /**
   * The hill: a dose that is bent, as a real one is. A level it never goes
   * below, how far above that its top is, where its top is, and how wide
   * it is (the σ of a Gaussian), in gray and mm.
   */
  hill: { level: 2, height: 60, centre: [1.7, -2.3, 0.9] as Triple, width: 20 },
} as const;

const D = DOSE_PHANTOM;

/** The linear dose at a place, in gray: reading it between voxels loses nothing. */
export function phantomLinearDose(point: Triple): number {
  const { at0, perMm } = D.linear;
  return at0 + perMm[0] * point[0] + perMm[1] * point[1] + perMm[2] * point[2];
}

/** How fast the linear dose changes, in gray a millimetre. */
export const PHANTOM_LINEAR_DOSE_SLOPE = Math.hypot(...D.linear.perMm);

/** The hill at a place, in gray. */
export function phantomHillDose(point: Triple): number {
  const { level, height, centre, width } = D.hill;
  const d2 =
    (point[0] - centre[0]) ** 2 + (point[1] - centre[1]) ** 2 + (point[2] - centre[2]) ** 2;
  return level + height * Math.exp(-d2 / (2 * width * width));
}

/** The most the hill is anywhere, in gray: at its top. */
export const PHANTOM_HILL_DOSE_MOST = D.hill.level + D.hill.height;

/**
 * How fast the hill changes at most, in gray a millimetre: a Gaussian is
 * steepest one width from its top, where it falls by its height over its
 * width, times e to the minus a half.
 */
export const PHANTOM_HILL_DOSE_SLOPE = (D.hill.height / D.hill.width) * Math.exp(-0.5);

/**
 * The most the hill read between voxels by linear interpolation is off the
 * hill itself, in gray: an eighth of the voxel spacing squared times how
 * sharply the hill bends along a line (at most its height over its width
 * squared, at its top), over the three axes.
 */
export function phantomHillInterpolationBound(spacing: Triple): number {
  const bend = D.hill.height / D.hill.width ** 2;
  return (bend * (spacing[0] ** 2 + spacing[1] ** 2 + spacing[2] ** 2)) / 8;
}
