/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The α/β ratio of every voxel, from structures (#100): what a dose is
// converted to BED or EQDx with (#99), where tissues differ.
//
// **Whose numbers these are.** An α/β ratio is a judgement about a tissue
// and an endpoint, and it is the user's. What is here are two generic
// starting values of the kind in common use, by a structure's type and
// nothing finer: 10 Gy for what is drawn as a target, 3 Gy for what is
// drawn as an organ. They are there to be changed, they are shown wherever
// they are used, and no structure is given a value by its name unless the
// user has made a rule for that name. A structure that neither a rule nor
// the user gives a value has none.
//
// **Which voxels are a structure's.** A voxel whose middle is within the
// structure's contour on its slice, by the even-odd rule: the structure
// the viewer fills (`contour-raster.ts`). The structures must be drawn on
// the slices of the grid the map is made on, as for a histogram (`dvh.ts`);
// one that is not is refused.
//
// **Where structures overlap, the first in the list has the voxel.** The
// list is the priority, and it is the user's to order. A structure with no
// value takes no part: a voxel that is only in such a structure is outside
// every structure that has one.
//
// **Outside every structure** a voxel has the outside value, when the user
// gives one, and otherwise none. A voxel with no α/β is 0 in the map, which
// is no ratio: a dose is not converted there, and the sum is not known
// (`dose-sum.ts`). Nothing is filled in.

import { fillLoops, roiLoopsBySlice } from './contour-raster.js';
import { DVH_ON_SLICE_MM } from './dvh.js';
import { resolveGeometry } from './label-volume.js';
import type { ResampleGrid } from './resample.js';
import type { Roi } from './types.js';

/** A rule that gives structures a starting α/β: by their type, or by their name. */
export interface AlphaBetaDefault {
  /** Whether {@link match} is an RT ROI Interpreted Type or an ROI Name. */
  readonly by: 'type' | 'name';
  /** The type or the name, compared without regard to case or to spaces at its ends. */
  readonly match: string;
  readonly alphaBetaGy: number;
}

/**
 * The starting values when the user has made no rules of their own: 10 Gy
 * for what is drawn as a target and 3 Gy for what is drawn as an organ.
 * Generic, by type alone, and to be changed.
 */
export const GENERIC_ALPHA_BETA_DEFAULTS: readonly AlphaBetaDefault[] = [
  { by: 'type', match: 'GTV', alphaBetaGy: 10 },
  { by: 'type', match: 'CTV', alphaBetaGy: 10 },
  { by: 'type', match: 'PTV', alphaBetaGy: 10 },
  { by: 'type', match: 'ORGAN', alphaBetaGy: 3 },
  { by: 'type', match: 'AVOIDANCE', alphaBetaGy: 3 },
];

/** Whether a number is an α/β ratio: of gray, and more than 0. */
export function isAlphaBeta(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const same = (a: string | null, b: string): boolean =>
  a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The α/β a structure starts with by the rules: the first rule for its
 * name, else the first for its type; null when no rule is for it. A rule
 * whose value is no ratio is passed over.
 */
export function defaultAlphaBeta(
  roi: Pick<Roi, 'name' | 'interpretedType'>,
  defaults: readonly AlphaBetaDefault[] = GENERIC_ALPHA_BETA_DEFAULTS,
): number | null {
  const usable = defaults.filter((rule) => isAlphaBeta(rule.alphaBetaGy));
  const rule =
    usable.find((one) => one.by === 'name' && same(roi.name, one.match)) ??
    usable.find((one) => one.by === 'type' && same(roi.interpretedType, one.match));
  return rule ? rule.alphaBetaGy : null;
}

/** A structure and the α/β of its tissue; null when it has none and takes no part. */
export interface AlphaBetaEntry {
  readonly roi: Roi;
  readonly alphaBetaGy: number | null;
}

/** The α/β of every voxel of a grid. */
export interface AlphaBetaMap {
  /** One ratio to a voxel, x fastest, in gray; 0 where a voxel has none. */
  readonly ratios: Float32Array;
  /**
   * How many voxels each entry has, in the entries' order: those within it
   * that no entry before it has. 0 for an entry with no value.
   */
  readonly voxels: readonly number[];
  /** How many voxels are in no structure that has a value. */
  readonly outside: number;
  /** How many voxels have no α/β at all: the outside voxels, when there is no outside value. */
  readonly without: number;
}

/** Why no map is made, in words for whoever asked. */
export class AlphaBetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlphaBetaError';
  }
}

/**
 * The α/β of every voxel of `grid`: of the first of `entries` the voxel is
 * within, and `outsideGy` for a voxel within none (null for no value
 * there).
 *
 * Throws an {@link AlphaBetaError} for a value that is no ratio, and for a
 * structure with a value that is not drawn on the grid's slices.
 */
export function alphaBetaMap(
  grid: ResampleGrid,
  entries: readonly AlphaBetaEntry[],
  outsideGy: number | null,
): AlphaBetaMap {
  if (outsideGy !== null && !isAlphaBeta(outsideGy)) {
    throw new AlphaBetaError('The α/β outside the structures is not a number of gray more than 0.');
  }
  for (const { roi, alphaBetaGy } of entries) {
    if (alphaBetaGy !== null && !isAlphaBeta(alphaBetaGy)) {
      throw new AlphaBetaError(`The α/β of “${roi.name}” is not a number of gray more than 0.`);
    }
  }
  const geometry = resolveGeometry(grid);
  const [nx, ny, nz] = grid.dims;
  // 0 is no ratio, and so is a voxel that no structure has yet.
  const ratios = new Float32Array(nx * ny * nz);
  const voxels = entries.map(() => 0);
  let within = 0;
  // From the first to the last, each taking only what none before it has.
  entries.forEach(({ roi, alphaBetaGy }, index) => {
    if (alphaBetaGy === null) return;
    const { bySlice, beyond, offSlice } = roiLoopsBySlice(geometry, nz, roi);
    if (beyond > 0 || offSlice * grid.spacing[2] > DVH_ON_SLICE_MM) {
      throw new AlphaBetaError(
        `“${roi.name}” is not drawn on the slices of the grid the doses are summed on.`,
      );
    }
    let taken = 0;
    for (const [slice, loops] of bySlice) {
      const base = slice * nx * ny;
      fillLoops(loops, nx, ny, (x, y) => {
        const voxel = base + y * nx + x;
        if (ratios[voxel] !== 0) return;
        ratios[voxel] = alphaBetaGy;
        taken++;
      });
    }
    voxels[index] = taken;
    within += taken;
  });
  const outside = ratios.length - within;
  if (outsideGy !== null && outside > 0) {
    for (let voxel = 0; voxel < ratios.length; voxel++) {
      if (ratios[voxel] === 0) ratios[voxel] = outsideGy;
    }
  }
  return { ratios, voxels, outside, without: outsideGy === null ? outside : 0 };
}

/** One structure's line of the settings that are kept: which it is, and its value. */
export interface AlphaBetaStructureSetting {
  /** ROI Number and ROI Name: a structure is the one that has both. */
  readonly number: number;
  readonly name: string;
  /** Its α/β in gray; null for a structure the user left without one. */
  readonly alphaBetaGy: number | null;
}

/** The α/β settings of a summation, as they are kept. */
export interface AlphaBetaSettings {
  /** The user's rules for starting values. */
  readonly defaults: readonly AlphaBetaDefault[];
  /** The structures the user has set, in the order of their priority: the first has a voxel two are in. */
  readonly structures: readonly AlphaBetaStructureSetting[];
  /** The α/β outside every structure, in gray; null for none. */
  readonly outsideGy: number | null;
}

/** The settings before the user has changed anything. */
export const DEFAULT_ALPHA_BETA_SETTINGS: AlphaBetaSettings = {
  defaults: GENERIC_ALPHA_BETA_DEFAULTS,
  structures: [],
  outsideGy: null,
};

/**
 * The structures of a set with their α/β, in the order of their priority:
 * those the settings have, in the settings' order and with the settings'
 * values, then the rest in the set's order, each with the starting value the
 * rules give it. A structure with no closed contour takes no part and is
 * left out.
 */
export function alphaBetaEntries(
  rois: readonly Roi[],
  settings: AlphaBetaSettings = DEFAULT_ALPHA_BETA_SETTINGS,
): AlphaBetaEntry[] {
  const fillable = rois.filter((roi) =>
    roi.contours.some(
      (contour) =>
        contour.points.length >= 3 &&
        contour.geometricType !== 'OPEN_PLANAR' &&
        contour.geometricType !== 'POINT',
    ),
  );
  const taken = new Set<Roi>();
  const entries: AlphaBetaEntry[] = [];
  for (const setting of settings.structures) {
    const roi = fillable.find(
      (one) => !taken.has(one) && one.number === setting.number && one.name === setting.name,
    );
    if (!roi) continue;
    taken.add(roi);
    entries.push({ roi, alphaBetaGy: setting.alphaBetaGy });
  }
  for (const roi of fillable) {
    if (!taken.has(roi))
      entries.push({ roi, alphaBetaGy: defaultAlphaBeta(roi, settings.defaults) });
  }
  return entries;
}

/** The settings that say what `entries` are: to keep them as the user has them. */
export function alphaBetaSettingsOf(
  entries: readonly AlphaBetaEntry[],
  defaults: readonly AlphaBetaDefault[],
  outsideGy: number | null,
): AlphaBetaSettings {
  return {
    defaults,
    structures: entries.map(({ roi, alphaBetaGy }) => ({
      number: roi.number,
      name: roi.name,
      alphaBetaGy,
    })),
    outsideGy,
  };
}

const SETTINGS_VERSION = 1;
/** No more rules or structures than this are read from what was kept. */
const SETTINGS_ITEMS_AT_MOST = 512;

/** The settings as the text that is kept: versioned JSON. */
export function serializeAlphaBetaSettings(settings: AlphaBetaSettings): string {
  return JSON.stringify({ version: SETTINGS_VERSION, ...settings });
}

const ratioOrNull = (value: unknown): number | null => (isAlphaBeta(value) ? value : null);

/**
 * The settings that were kept, read back. Anything that is not as it should
 * be is left out and not guessed at: a rule or a structure that is
 * malformed is dropped, a value that is no ratio is none. Text that is not
 * the settings at all, or of another version, gives null.
 */
export function parseAlphaBetaSettings(text: string | null): AlphaBetaSettings | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const given = parsed as Record<string, unknown>;
  if (given['version'] !== SETTINGS_VERSION) return null;
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value
          .slice(0, SETTINGS_ITEMS_AT_MOST)
          .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
      : [];
  const defaults = list(given['defaults']).flatMap((one): AlphaBetaDefault[] => {
    const { by, match, alphaBetaGy } = one;
    if ((by !== 'type' && by !== 'name') || typeof match !== 'string' || !match.trim()) return [];
    return isAlphaBeta(alphaBetaGy) ? [{ by, match: match.trim(), alphaBetaGy }] : [];
  });
  const structures = list(given['structures']).flatMap((one): AlphaBetaStructureSetting[] => {
    const { number, name } = one;
    if (typeof number !== 'number' || !Number.isInteger(number) || typeof name !== 'string') {
      return [];
    }
    return [{ number, name, alphaBetaGy: ratioOrNull(one['alphaBetaGy']) }];
  });
  return { defaults, structures, outsideGy: ratioOrNull(given['outsideGy']) };
}
