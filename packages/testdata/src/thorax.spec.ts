/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  addSeriesToCatalog,
  buildVolume,
  groupSeries,
  parseFile,
  parseStructureSet,
  patientToVoxel,
  structureSetsForSeries,
  type PatientCatalogMap,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';

import {
  syntheticThoraxPatient,
  THORAX,
  THORAX_CT_TEXTURE,
  THORAX_FOLLOW_UP_STUDY,
  THORAX_HU,
  THORAX_PATIENT,
  THORAX_PLANNING_STUDY,
  THORAX_PRESCRIPTION_GY,
  thoraxDoseGy,
  thoraxGrid,
  thoraxRois,
  thoraxTissueAt,
  type SyntheticFile,
  type ThoraxTissue,
} from './index.js';

// Small sampling keeps the specs fast; the anatomy is defined in millimetres,
// so it is the same phantom at any resolution.
const OPTIONS = { size: 48, slices: 24, doseSpacing: 8 } as const;
const files = syntheticThoraxPatient(OPTIONS);

const buffer = (file: SyntheticFile): ArrayBuffer => file.bytes.slice().buffer;
const images = files.filter((f) => !/rtstruct|rtdose/.test(f.name));
const series = groupSeries(images.flatMap((f) => parseFile(f.name, buffer(f))));

function find(modality: string, studyIndex: number): Series {
  const date =
    studyIndex === THORAX_PLANNING_STUDY.index
      ? THORAX_PLANNING_STUDY.date
      : THORAX_FOLLOW_UP_STUDY.date;
  const match = series.find((s) => s.modality === modality && s.studyDate === date);
  if (!match) throw new Error(`no ${modality} series in study ${studyIndex}`);
  return match;
}

/** The value of a volume at the voxel nearest a patient position. */
function valueAt(volume: Volume, x: number, y: number, z: number): number {
  const voxel = patientToVoxel(volume.geometry!, [x, y, z])!;
  const [i, j, k] = voxel.map(Math.round);
  const [nx, ny] = volume.dims;
  return volume.data[(k * ny + j) * nx + i];
}

describe('thoraxTissueAt', () => {
  const probes: [ThoraxTissue, number, number, number][] = [
    ['air', 0, -150, 0],
    ['air', 180, 0, 0],
    ['fat', 0, -104, 0],
    ['muscle', 0, -80, 60],
    ['lung', -80, 30, 0],
    ['lung', 80, -10, 0],
    ['heart', 0, -20, -10],
    ['bone', 0, 52, 0],
    ['canal', 0, 65, 40],
    ['tumor', -80, -20, 10],
  ];

  it.each(probes)('finds %s at (%d, %d, %d)', (tissue, x, y, z) => {
    expect(thoraxTissueAt(x, y, z)).toBe(tissue);
  });

  it('has a smaller tumour in the follow-up', () => {
    const [x, y, z] = THORAX.tumor.center;
    const edge = x + 12; // inside the planning tumour, outside the follow-up one
    expect(thoraxTissueAt(edge, y, z, THORAX.tumor.radius)).toBe('tumor');
    expect(thoraxTissueAt(edge, y, z, THORAX.tumor.followUpRadius)).toBe('lung');
  });

  it('keeps the organs apart from each other', () => {
    // The shapes are meant not to overlap, so each elliptical contour in the
    // structure set really is the outline of its organ.
    const [lx] = THORAX.lungLeft.center;
    const leftLungInnerEdge = lx - THORAX.lungLeft.semiAxes[0];
    const heartOuterEdge = THORAX.heart.center[0] + THORAX.heart.semiAxes[0];
    expect(leftLungInnerEdge).toBeGreaterThan(heartOuterEdge);
  });
});

describe('the phantom CT', () => {
  const ct = buildVolume(find('CT', THORAX_PLANNING_STUDY.index).slices);
  const grid = thoraxGrid(OPTIONS);

  it('has the stated geometry, centred on the origin', () => {
    expect(ct.dims).toEqual([OPTIONS.size, OPTIONS.size, OPTIONS.slices]);
    expect(ct.spacing).toEqual([grid.pixelSpacing, grid.pixelSpacing, grid.sliceSpacing]);
    expect(ct.geometry!.origin).toEqual([...grid.origin]);
    expect(ct.modality).toBe('CT');
  });

  it('reads in Hounsfield units through the rescale', () => {
    expect(ct.rescaleIntercept).toBe(-1024);
    expect(valueAt(ct, 0, -150, 0)).toBe(THORAX_HU.air);
    for (const [tissue, x, y, z] of [
      ['lung', -80, 30, 0],
      ['muscle', 0, -80, 60],
      ['bone', 0, 52, 0],
      ['tumor', -80, -20, 10],
      ['heart', 0, -20, -10],
    ] as const) {
      const hu = valueAt(ct, x, y, z);
      expect(Math.abs(hu - THORAX_HU[tissue]), tissue).toBeLessThanOrEqual(THORAX_CT_TEXTURE);
    }
  });

  it('matches thoraxTissueAt at every voxel of a slice', () => {
    const k = Math.floor(OPTIONS.slices / 2);
    const z = grid.origin[2] + k * grid.sliceSpacing;
    let checked = 0;
    for (let j = 0; j < OPTIONS.size; j++) {
      for (let i = 0; i < OPTIONS.size; i++) {
        const tissue = thoraxTissueAt(
          grid.origin[0] + i * grid.pixelSpacing,
          grid.origin[1] + j * grid.pixelSpacing,
          z,
        );
        const hu = ct.data[(k * OPTIONS.size + j) * OPTIONS.size + i];
        if (Math.abs(hu - THORAX_HU[tissue]) > THORAX_CT_TEXTURE) {
          throw new Error(`voxel (${i}, ${j}, ${k}) is ${hu} HU but ${tissue} was expected`);
        }
        checked++;
      }
    }
    expect(checked).toBe(OPTIONS.size * OPTIONS.size);
  });
});

describe('the other phantom series', () => {
  it('has an MR in the frame of reference of the planning CT', () => {
    const ct = find('CT', THORAX_PLANNING_STUDY.index);
    const mr = find('MR', THORAX_PLANNING_STUDY.index);
    expect(mr.frameOfReferenceUid).toBe(ct.frameOfReferenceUid);
    const volume = buildVolume(mr.slices);
    // Fluid in the canal is the brightest thing on the T2-like image; bone is dark.
    expect(valueAt(volume, 0, 65, 0)).toBeGreaterThan(valueAt(volume, 0, 52, 0) + 500);
  });

  it('shows the tumour shrinking in the follow-up CT', () => {
    const planning = buildVolume(find('CT', THORAX_PLANNING_STUDY.index).slices);
    const followUp = buildVolume(find('CT', THORAX_FOLLOW_UP_STUDY.index).slices);
    const [x, y, z] = THORAX.tumor.center;
    expect(valueAt(planning, x + 12, y, z)).toBeGreaterThan(-100); // tumour
    expect(valueAt(followUp, x + 12, y, z)).toBeLessThan(-700); // lung again
    expect(valueAt(followUp, x, y, z)).toBeGreaterThan(-100); // still tumour at the centre
  });

  it('catalogues as one synthetic patient with two studies', () => {
    const empty: PatientCatalogMap = new Map();
    const all = groupSeries(files.flatMap((f) => parseFile(f.name, buffer(f))));
    const [patient] = [...addSeriesToCatalog(empty, all).values()];
    expect(patient.patientId).toBe(THORAX_PATIENT.id);
    expect(patient.name).toBe(THORAX_PATIENT.name);
    expect(patient.studies.map((s) => s.date).sort()).toEqual([
      THORAX_PLANNING_STUDY.date,
      THORAX_FOLLOW_UP_STUDY.date,
    ]);
  });
});

describe('the phantom structure set', () => {
  const file = files.find((f) => f.name === 'thorax-rtstruct.dcm')!;
  const structureSet = parseStructureSet(file.name, buffer(file))!;
  const grid = thoraxGrid(OPTIONS);

  it('lists the structures of thoraxRois with their types and colours', () => {
    const expected = thoraxRois();
    expect(structureSet.rois.map((r) => r.name)).toEqual(expected.map((r) => r.name));
    expect(structureSet.rois.map((r) => r.name)).toEqual([
      'BODY',
      'Lung_R',
      'Lung_L',
      'Heart',
      'SpinalCanal',
      'GTV',
      'PTV_60',
    ]);
    expect(structureSet.rois.map((r) => r.interpretedType)).toEqual(expected.map((r) => r.type));
    expect(structureSet.rois.map((r) => r.color)).toEqual(expected.map((r) => r.color));
  });

  it('belongs to the planning CT and not to the follow-up', () => {
    expect(
      structureSetsForSeries([structureSet], find('CT', THORAX_PLANNING_STUDY.index)),
    ).toHaveLength(1);
    expect(
      structureSetsForSeries([structureSet], find('CT', THORAX_FOLLOW_UP_STUDY.index)),
    ).toHaveLength(0);
  });

  it('puts every contour point on the outline of its structure, on an image slice', () => {
    const sliceZs = Array.from(
      { length: grid.slices },
      (_, k) => grid.origin[2] + k * grid.sliceSpacing,
    );
    for (const [index, roi] of structureSet.rois.entries()) {
      const shape = thoraxRois()[index];
      expect(roi.contours.length, roi.name).toBeGreaterThan(0);
      for (const contour of roi.contours) {
        const z = contour.points[0][2];
        expect(
          sliceZs.some((s) => Math.abs(s - z) < 1e-3),
          `${roi.name} z=${z}`,
        ).toBe(true);
        const section = shape.section(z)!;
        for (const [x, y] of contour.points) {
          const r =
            ((x - section.center[0]) / section.semiAxes[0]) ** 2 +
            ((y - section.center[1]) / section.semiAxes[1]) ** 2;
          expect(r).toBeCloseTo(1, 3);
        }
      }
    }
  });

  it('draws the body on every slice and the tumour only where it is', () => {
    const body = structureSet.rois.find((r) => r.name === 'BODY')!;
    expect(body.contours).toHaveLength(grid.slices);
    const gtv = structureSet.rois.find((r) => r.name === 'GTV')!;
    const zs = gtv.contours.map((c) => c.points[0][2]);
    const [, , tz] = THORAX.tumor.center;
    expect(Math.min(...zs)).toBeGreaterThan(tz - THORAX.tumor.radius);
    expect(Math.max(...zs)).toBeLessThan(tz + THORAX.tumor.radius);
  });

  it('encloses tumour tissue with the GTV and more with the PTV', () => {
    const [x, y, z] = THORAX.tumor.center;
    const ptvEdge = THORAX.tumor.radius + THORAX.ptvMargin;
    expect(thoraxTissueAt(x + THORAX.tumor.radius - 1, y, z)).toBe('tumor');
    expect(thoraxTissueAt(x + ptvEdge - 1, y, z)).toBe('lung');
  });
});

describe('the phantom dose', () => {
  const file = files.find((f) => f.name === 'thorax-rtdose.dcm')!;
  const slices = parseFile(file.name, buffer(file));
  const dose = buildVolume(slices);

  it('is a dose grid in the planning frame of reference', () => {
    expect(slices[0].modality).toBe('RTDOSE');
    expect(slices[0].frameOfReferenceUid).toBe(
      find('CT', THORAX_PLANNING_STUDY.index).frameOfReferenceUid,
    );
    expect(dose.spacing).toEqual([8, 8, 8]);
  });

  it('gives the prescription in the target and falls off outside it', () => {
    const [x, y, z] = THORAX.tumor.center;
    expect(thoraxDoseGy(x, y, z)).toBe(THORAX_PRESCRIPTION_GY);
    expect(thoraxDoseGy(x + THORAX.tumor.radius + THORAX.ptvMargin, y, z)).toBe(
      THORAX_PRESCRIPTION_GY,
    );
    expect(thoraxDoseGy(x + 60, y, z)).toBeLessThan(THORAX_PRESCRIPTION_GY / 2);
    expect(thoraxDoseGy(80, -10, 0)).toBeLessThan(0.01); // the other lung
  });

  it('stores thoraxDoseGy at every grid point checked', () => {
    const geometry = dose.geometry!;
    const [nx, ny, nz] = dose.dims;
    for (const [i, j, k] of [
      [0, 0, 0],
      [nx - 1, ny - 1, nz - 1],
      [Math.floor(nx / 4), Math.floor(ny / 2), Math.floor(nz / 2)],
      [Math.floor(nx / 2), Math.floor(ny / 3), Math.floor(nz / 2) + 1],
    ]) {
      const x = geometry.origin[0] + i * dose.spacing[0];
      const y = geometry.origin[1] + j * dose.spacing[1];
      const z = geometry.origin[2] + k * dose.spacing[2];
      expect(dose.data[(k * ny + j) * nx + i]).toBeCloseTo(thoraxDoseGy(x, y, z), 2);
    }
    expect(dose.max).toBeCloseTo(THORAX_PRESCRIPTION_GY, 2);
  });
});

describe('the phantom as a whole', () => {
  it('is generated identically on every call', () => {
    const again = syntheticThoraxPatient(OPTIONS);
    expect(again.map((f) => f.name)).toEqual(files.map((f) => f.name));
    again.forEach((f, i) => expect(f.bytes, f.name).toEqual(files[i].bytes));
  });

  it('has unique file names', () => {
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
  });
});
