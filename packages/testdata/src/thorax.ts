/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A synthetic thorax phantom: simple geometric "anatomy" that is enough to
// show what the viewer does with a planning CT, an MR, a structure set, a dose
// and a follow-up study. It is built from ellipses, spheres and cylinders, not
// from any person or scan, and everything about it is defined in this file.
//
// All coordinates are patient coordinates in millimetres, head-first supine:
// +x is the patient's left, +y is posterior, +z is towards the head. The
// centre of the phantom is the origin.

import {
  type SyntheticFile,
  type SyntheticPatientIdentity,
  type SyntheticStudy,
} from './identity.js';
import { writeImageSeries } from './image-series.js';
import { writeRtDose } from './rtdose.js';
import { writeRtStruct, type RtStructRoi } from './rtstruct.js';

export const THORAX_PATIENT: SyntheticPatientIdentity = {
  id: 'SYN-0002',
  name: 'SYNTHETIC^THORAX',
};

export const THORAX_PLANNING_STUDY: SyntheticStudy = {
  index: 11,
  date: '20260202',
  time: '101500',
  description: 'Synthetic thorax planning',
  patient: THORAX_PATIENT,
};

export const THORAX_FOLLOW_UP_STUDY: SyntheticStudy = {
  index: 12,
  date: '20260511',
  time: '143000',
  description: 'Synthetic thorax follow-up',
  patient: THORAX_PATIENT,
};

/** The shapes the phantom is made of. Semi-axes and radii in mm. */
export const THORAX = {
  /** Size of the imaged block: 384 by 384 mm in plane, 192 mm along z. */
  fieldOfView: 384,
  depth: 192,
  /** Elliptic cylinder along z. */
  body: { semiAxes: [160, 110] as const },
  /** Thickness of the fat layer under the body surface. */
  fatThickness: 12,
  /** Ellipsoids. The right lung is on the patient's right, at negative x. */
  lungRight: { center: [-80, -10, 0] as const, semiAxes: [45, 65, 80] as const },
  lungLeft: { center: [80, -10, 0] as const, semiAxes: [45, 65, 80] as const },
  /** Ellipsoid between the lungs. The shapes do not overlap one another. */
  heart: { center: [0, -20, -10] as const, semiAxes: [30, 32, 40] as const },
  /** Cylinders along z: the vertebral column and the canal inside it. */
  spine: { center: [0, 65] as const, radius: 16 },
  canal: { center: [0, 65] as const, radius: 6 },
  /** Sphere in the right lung. It is smaller in the follow-up study. */
  tumor: { center: [-80, -20, 10] as const, radius: 14, followUpRadius: 9 },
  /** Margin from the tumour to the planning target. */
  ptvMargin: 8,
} as const;

export type ThoraxTissue = 'air' | 'lung' | 'fat' | 'muscle' | 'heart' | 'bone' | 'canal' | 'tumor';

/** CT number of each tissue in Hounsfield units, before the small texture. */
export const THORAX_HU: Readonly<Record<ThoraxTissue, number>> = {
  air: -1000,
  lung: -780,
  fat: -90,
  muscle: 45,
  heart: 60,
  bone: 650,
  canal: 25,
  tumor: 35,
};

/** MR signal of each tissue (arbitrary units), before the small texture. */
export const THORAX_MR: Readonly<Record<ThoraxTissue, number>> = {
  air: 0,
  lung: 40,
  fat: 900,
  muscle: 380,
  heart: 520,
  bone: 120,
  canal: 1000,
  tumor: 820,
};

/** Largest deviation the texture adds to a CT value, in HU. */
export const THORAX_CT_TEXTURE = 8;

/** The CT is stored unsigned with this Rescale Intercept. */
const CT_INTERCEPT = -1024;

/** Prescribed dose to the planning target, in Gy. */
export const THORAX_PRESCRIPTION_GY = 60;

/** Dose Grid Scaling of the phantom dose: 1 mGy per stored unit. */
const DOSE_SCALING = 0.001;

type Triple = readonly [number, number, number];

function inEllipsoid(x: number, y: number, z: number, center: Triple, semi: Triple): boolean {
  const dx = (x - center[0]) / semi[0];
  const dy = (y - center[1]) / semi[1];
  const dz = (z - center[2]) / semi[2];
  return dx * dx + dy * dy + dz * dz <= 1;
}

/**
 * The tissue at a patient position. `tumorRadius` lets the follow-up study
 * shrink the tumour; everything else is the same in both studies.
 */
export function thoraxTissueAt(
  x: number,
  y: number,
  z: number,
  tumorRadius: number = THORAX.tumor.radius,
): ThoraxTissue {
  const [a, b] = THORAX.body.semiAxes;
  if ((x / a) ** 2 + (y / b) ** 2 > 1) return 'air';

  const [tx, ty, tz] = THORAX.tumor.center;
  if (Math.hypot(x - tx, y - ty, z - tz) <= tumorRadius) return 'tumor';

  const spineDistance = Math.hypot(x - THORAX.spine.center[0], y - THORAX.spine.center[1]);
  if (spineDistance <= THORAX.canal.radius) return 'canal';
  if (spineDistance <= THORAX.spine.radius) return 'bone';

  if (inEllipsoid(x, y, z, THORAX.heart.center, THORAX.heart.semiAxes)) return 'heart';
  if (inEllipsoid(x, y, z, THORAX.lungRight.center, THORAX.lungRight.semiAxes)) return 'lung';
  if (inEllipsoid(x, y, z, THORAX.lungLeft.center, THORAX.lungLeft.semiAxes)) return 'lung';

  const fat = THORAX.fatThickness;
  if ((x / (a - fat)) ** 2 + (y / (b - fat)) ** 2 > 1) return 'fat';
  return 'muscle';
}

/**
 * The planned dose in Gy at a patient position: the prescription inside the
 * planning target, falling off smoothly with distance from it. It is a shape
 * that looks like a dose, not a calculation of one.
 */
export function thoraxDoseGy(x: number, y: number, z: number): number {
  const [tx, ty, tz] = THORAX.tumor.center;
  const targetRadius = THORAX.tumor.radius + THORAX.ptvMargin;
  const beyond = Math.max(0, Math.hypot(x - tx, y - ty, z - tz) - targetRadius);
  return THORAX_PRESCRIPTION_GY * Math.exp(-((beyond / 22) ** 2));
}

/** A deterministic value in [-1, 1] from three integers: the image texture. */
function texture(i: number, j: number, k: number): number {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** How the phantom is sampled into images. */
export interface ThoraxOptions {
  /** Rows and columns of each image slice. Default 128 (3 mm pixels). */
  readonly size?: number;
  /** Number of image slices. Default 64 (3 mm apart). */
  readonly slices?: number;
  /** Spacing of the dose grid in mm, in all three directions. Default 4. */
  readonly doseSpacing?: number;
}

/** The sampling grid of the phantom images for the given options. */
export function thoraxGrid(options: ThoraxOptions = {}): {
  readonly size: number;
  readonly slices: number;
  readonly pixelSpacing: number;
  readonly sliceSpacing: number;
  /** Patient position of the centre of voxel (0, 0, 0). */
  readonly origin: Triple;
} {
  const size = options.size ?? 128;
  const slices = options.slices ?? 64;
  const pixelSpacing = THORAX.fieldOfView / size;
  const sliceSpacing = THORAX.depth / slices;
  return {
    size,
    slices,
    pixelSpacing,
    sliceSpacing,
    origin: [
      -THORAX.fieldOfView / 2 + pixelSpacing / 2,
      -THORAX.fieldOfView / 2 + pixelSpacing / 2,
      -THORAX.depth / 2 + sliceSpacing / 2,
    ],
  };
}

function imageSeries(
  modality: 'CT' | 'MR',
  study: SyntheticStudy,
  seriesIndex: number,
  description: string,
  tumorRadius: number,
  options: ThoraxOptions,
): SyntheticFile[] {
  const grid = thoraxGrid(options);
  const [ox, oy, oz] = grid.origin;
  const ct = modality === 'CT';
  return writeImageSeries({
    modality,
    study,
    seriesIndex,
    description,
    namePrefix: `thorax-${modality.toLowerCase()}-s${study.index}`,
    rows: grid.size,
    columns: grid.size,
    count: grid.slices,
    pixelSpacing: grid.pixelSpacing,
    sliceSpacing: grid.sliceSpacing,
    origin: grid.origin,
    window: ct ? [-300, 1600] : [500, 1000],
    rescaleIntercept: ct ? CT_INTERCEPT : undefined,
    stored: (column, row, slice) => {
      const tissue = thoraxTissueAt(
        ox + column * grid.pixelSpacing,
        oy + row * grid.pixelSpacing,
        oz + slice * grid.sliceSpacing,
        tumorRadius,
      );
      const grain = texture(column, row, slice);
      if (ct) {
        // Air stays exactly at -1000 HU; tissue gets a little texture.
        const hu =
          THORAX_HU[tissue] + (tissue === 'air' ? 0 : Math.round(grain * THORAX_CT_TEXTURE));
        return hu - CT_INTERCEPT;
      }
      return Math.max(0, THORAX_MR[tissue] + (tissue === 'air' ? 0 : Math.round(grain * 15)));
    },
  });
}

/** What a phantom structure is, so tests can check contours against it. */
export interface ThoraxRoi {
  readonly number: number;
  readonly name: string;
  /** RT ROI Interpreted Type. */
  readonly type: string;
  readonly color: readonly [number, number, number];
  /**
   * The cross-section at height z: centre and semi-axes of an ellipse, or null
   * where the structure does not reach that plane.
   */
  readonly section: (z: number) => {
    readonly center: readonly [number, number];
    readonly semiAxes: readonly [number, number];
  } | null;
}

function ellipsoidSection(center: Triple, semi: Triple): ThoraxRoi['section'] {
  return (z) => {
    const t = (z - center[2]) / semi[2];
    if (Math.abs(t) >= 1) return null;
    const scale = Math.sqrt(1 - t * t);
    return { center: [center[0], center[1]], semiAxes: [semi[0] * scale, semi[1] * scale] };
  };
}

function cylinderSection(center: readonly [number, number], semi: readonly [number, number]) {
  return () => ({ center, semiAxes: semi });
}

/** The structures of the phantom's RTSTRUCT, in ROI number order. */
export function thoraxRois(): ThoraxRoi[] {
  const tumor = THORAX.tumor;
  const ptvRadius = tumor.radius + THORAX.ptvMargin;
  const sphere = (r: number): Triple => [r, r, r];
  const rois: Omit<ThoraxRoi, 'number'>[] = [
    {
      name: 'BODY',
      type: 'EXTERNAL',
      color: [0, 200, 90],
      section: cylinderSection([0, 0], THORAX.body.semiAxes),
    },
    {
      name: 'Lung_R',
      type: 'ORGAN',
      color: [70, 150, 255],
      section: ellipsoidSection(THORAX.lungRight.center, THORAX.lungRight.semiAxes),
    },
    {
      name: 'Lung_L',
      type: 'ORGAN',
      color: [70, 220, 230],
      section: ellipsoidSection(THORAX.lungLeft.center, THORAX.lungLeft.semiAxes),
    },
    {
      name: 'Heart',
      type: 'ORGAN',
      color: [255, 90, 160],
      section: ellipsoidSection(THORAX.heart.center, THORAX.heart.semiAxes),
    },
    {
      name: 'SpinalCanal',
      type: 'ORGAN',
      color: [255, 220, 60],
      section: cylinderSection(THORAX.canal.center, [THORAX.canal.radius, THORAX.canal.radius]),
    },
    {
      name: 'GTV',
      type: 'GTV',
      color: [255, 60, 60],
      section: ellipsoidSection(tumor.center, sphere(tumor.radius)),
    },
    {
      name: 'PTV_60',
      type: 'PTV',
      color: [255, 150, 40],
      section: ellipsoidSection(tumor.center, sphere(ptvRadius)),
    },
  ];
  return rois.map((roi, i) => ({ ...roi, number: i + 1 }));
}

function structureSet(options: ThoraxOptions): SyntheticFile {
  const grid = thoraxGrid(options);
  const points = 48;
  const rois: RtStructRoi[] = thoraxRois().map((roi) => {
    const contours: number[][] = [];
    for (let k = 0; k < grid.slices; k++) {
      const z = grid.origin[2] + k * grid.sliceSpacing;
      const section = roi.section(z);
      // Skip planes the structure only grazes: a contour needs some size.
      if (!section || Math.min(...section.semiAxes) < grid.pixelSpacing / 2) continue;
      const contour: number[] = [];
      for (let i = 0; i < points; i++) {
        const angle = (i / points) * 2 * Math.PI;
        contour.push(
          Number((section.center[0] + section.semiAxes[0] * Math.cos(angle)).toFixed(3)),
          Number((section.center[1] + section.semiAxes[1] * Math.sin(angle)).toFixed(3)),
          Number(z.toFixed(3)),
        );
      }
      contours.push(contour);
    }
    return { number: roi.number, name: roi.name, type: roi.type, color: roi.color, contours };
  });
  return writeRtStruct({
    study: THORAX_PLANNING_STUDY,
    label: 'Synthetic thorax',
    fileName: 'thorax-rtstruct.dcm',
    rois,
  });
}

/** The dose grid of the phantom: it covers the body with a small margin. */
export function thoraxDoseGrid(options: ThoraxOptions = {}): {
  readonly spacing: number;
  readonly columns: number;
  readonly rows: number;
  readonly frames: number;
  readonly origin: Triple;
} {
  const spacing = options.doseSpacing ?? 4;
  const [a, b] = THORAX.body.semiAxes;
  const halfX = a + spacing;
  const halfY = b + spacing;
  const halfZ = THORAX.depth / 2;
  return {
    spacing,
    columns: Math.floor((2 * halfX) / spacing) + 1,
    rows: Math.floor((2 * halfY) / spacing) + 1,
    frames: Math.floor((2 * halfZ) / spacing) + 1,
    origin: [-halfX, -halfY, -halfZ],
  };
}

function dose(options: ThoraxOptions): SyntheticFile {
  const grid = thoraxDoseGrid(options);
  const [ox, oy, oz] = grid.origin;
  return writeRtDose({
    study: THORAX_PLANNING_STUDY,
    fileName: 'thorax-rtdose.dcm',
    rows: grid.rows,
    columns: grid.columns,
    frames: grid.frames,
    origin: grid.origin,
    pixelSpacing: grid.spacing,
    frameSpacing: grid.spacing,
    scaling: DOSE_SCALING,
    stored: (column, row, frame) =>
      Math.round(
        thoraxDoseGy(
          ox + column * grid.spacing,
          oy + row * grid.spacing,
          oz + frame * grid.spacing,
        ) / DOSE_SCALING,
      ),
  });
}

/**
 * The whole phantom patient as one batch, like a folder a user would open:
 *
 * - planning study: CT in Hounsfield units, an MR in the same Frame of
 *   Reference, a structure set matching the anatomy, and a dose on the target
 * - follow-up study three months later: a CT in which the tumour has shrunk
 *
 * The default sampling (128 by 128 by 64) is meant for looking at; tests pass
 * a small `size` and `slices` to keep it fast.
 */
export function syntheticThoraxPatient(options: ThoraxOptions = {}): SyntheticFile[] {
  const tumor = THORAX.tumor;
  return [
    ...imageSeries('CT', THORAX_PLANNING_STUDY, 1, 'Planning CT', tumor.radius, options),
    ...imageSeries('MR', THORAX_PLANNING_STUDY, 2, 'T2-like MR', tumor.radius, options),
    structureSet(options),
    dose(options),
    ...imageSeries('CT', THORAX_FOLLOW_UP_STUDY, 1, 'Follow-up CT', tumor.followUpRadius, options),
  ];
}
