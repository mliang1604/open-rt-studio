/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import { describe, expect, it } from 'vitest';

import { registrationReference } from './derived-series.js';
import { summedDoseVolume, type DoseSum } from './dose-sum.js';
import { readInstanceHeader } from './instance-header.js';
import { parseFile } from './loader.js';
import { rigidMat4, type Mat4 } from './mat4.js';
import type { ResampleGrid } from './resample.js';
import {
  SUM_RECORD_CREATOR,
  packKnown,
  parseDoseSumMade,
  serializeDoseSumMade,
  unpackKnown,
  type DoseSumMade,
} from './rt-dose.js';
import {
  DoseWriteError,
  RT_DOSE_SOP_CLASS,
  RT_PLAN_SOP_CLASS,
  doseSumAsciiName,
  summedDoseDescription,
  writeSummedDose,
  type SummedDoseContent,
  type SummedDoseSource,
} from './rt-dose-writer.js';
import type { Vec3, Volume } from './types.js';
import { buildVolume } from './volume.js';

type Dims = readonly [number, number, number];

function gridOf(dims: Dims, spacing: Vec3, origin: Vec3, turn?: Mat4): ResampleGrid {
  const t = turn ?? rigidMat4([0, 0, 1], 0);
  const step = (axis: number): Vec3 => [
    t[axis] * spacing[axis],
    t[4 + axis] * spacing[axis],
    t[8 + axis] * spacing[axis],
  ];
  return { dims, spacing, geometry: { iStep: step(0), jStep: step(1), kStep: step(2), origin } };
}

const PHYSICAL: DoseSumMade = { doses: 2, model: 'physical' };
const EQD2: DoseSumMade = { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 };

/** A sum on a grid: a value to each voxel, and whether it is known there. */
function sumOn(
  grid: ResampleGrid,
  made: DoseSumMade,
  value: (index: Vec3) => number,
  isKnown: (index: Vec3) => boolean = () => true,
): Volume {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  const known = new Uint8Array(nx * ny * nz);
  let [at, knownCount] = [0, 0];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at++) {
        if (!isKnown([i, j, k])) continue;
        known[at] = 1;
        knownCount++;
        data[at] = value([i, j, k]);
      }
    }
  }
  const sum: DoseSum = { data, known, knownCount, terms: [], made, withoutAlphaBeta: 0 };
  return summedDoseVolume(sum, grid);
}

/** A ramp that no two voxels share, in gray. */
const ramp = ([i, j, k]: Vec3): number => 1.25 + 0.371 * i + 0.0193 * j + 2.0007 * k;

const DOSE_A = '1.2.826.0.1.3680043.8.498.1';
const DOSE_B = '1.2.826.0.1.3680043.8.498.2';
const PLAN_A = '1.2.826.0.1.3680043.8.498.11';
const PLAN_B = '1.2.826.0.1.3680043.8.498.12';
const REGISTRATION = '1.2.826.0.1.3680043.8.498.21';

const HERE: SummedDoseSource = {
  sopInstanceUid: DOSE_A,
  planUids: [PLAN_A],
  registrations: [],
  transform: 'none',
};
const MOVED: SummedDoseSource = {
  sopInstanceUid: DOSE_B,
  planUids: [PLAN_B],
  registrations: [registrationReference(REGISTRATION, false)],
  transform: 'rigid',
};

function contentOf(volume: Volume, more: Partial<SummedDoseContent> = {}): SummedDoseContent {
  return {
    volume,
    frameOfReferenceUid: '1.2.826.0.1.3680043.8.498.31',
    patientName: 'SYNTHETIC^PHANTOM',
    patientId: 'SYN-001',
    studyInstanceUid: '1.2.826.0.1.3680043.8.498.41',
    studyDate: '20260105',
    studyTime: '101500',
    studyDescription: 'Synthetic planning study',
    seriesNumber: null,
    sources: [HERE, MOVED],
    derivationDescription: 'Made with Open RT Studio. Not for clinical use. Sum of 2 doses.',
    ...more,
  };
}

const AT = new Date(2026, 10, 15, 9, 30, 5);

/** The file read again as the viewer reads any dose. */
const readBack = (bytes: ArrayBuffer): Volume => buildVolume(parseFile('sum.dcm', bytes));

/** Where a voxel's middle is in the patient. */
function placeOf(volume: Pick<Volume, 'geometry'>, [i, j, k]: Vec3): Vec3 {
  const { origin, iStep, jStep, kStep } = volume.geometry!;
  return [0, 1, 2].map(
    (axis) => origin[axis] + i * iStep[axis] + j * jStep[axis] + k * kStep[axis],
  ) as unknown as Vec3;
}

/** A value is read back to within half the scaling, and what 32 bits of float can tell apart. */
const near = (written: number, scaling: number): number =>
  scaling / 2 + Math.abs(written) * 1.3e-7 + 1e-12;

const items = (dataSet: dicomParser.DataSet, tag: string): dicomParser.DataSet[] =>
  (dataSet.elements[tag]?.items ?? []).map((item) => item.dataSet!);
const codes = (dataSet: dicomParser.DataSet, tag: string): string[] =>
  items(dataSet, tag).map(
    (item) => `${item.string('x00080100')} ${item.string('x00080102')} ${item.string('x00080104')}`,
  );

describe('writeSummedDose', () => {
  const ASKEW = gridOf([7, 6, 5], [1.5, 2, 2.5], [-10.5, 4.25, 30], rigidMat4([0.2, -0.1, 1], 17));

  it('writes a sum that is read back with the same values at the same places', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const written = writeSummedDose(contentOf(sum), { createdAt: AT });
    expect(written.dims).toEqual([7, 6, 5]);
    expect(written.scaling).toBe(1e-6);
    expect(written.unknownCount).toBe(0);

    const read = readBack(written.bytes);
    expect(read.dims).toEqual(sum.dims);
    expect(read.modality).toBe('RTDOSE');
    for (const index of [
      [0, 0, 0],
      [6, 0, 0],
      [0, 5, 0],
      [0, 0, 4],
      [6, 5, 4],
    ] as Vec3[]) {
      const [there, here] = [placeOf(read, index), placeOf(sum, index)];
      for (const axis of [0, 1, 2]) expect(there[axis]).toBeCloseTo(here[axis], 9);
    }
    expect(read.known).toBeUndefined();
    for (let voxel = 0; voxel < sum.data.length; voxel++) {
      expect(Math.abs(read.data[voxel] - sum.data[voxel])).toBeLessThanOrEqual(
        near(sum.data[voxel], written.scaling),
      );
    }
    expect(read.dose).toMatchObject({
      units: 'GY',
      type: 'PHYSICAL',
      summationType: 'MULTI_PLAN',
      scaling: 1e-6,
      sopInstanceUid: written.sopInstanceUid,
      frameOffsets: 'relative',
      interpolatedPlanes: 0,
      sum: PHYSICAL,
    });
  });

  it('writes the box where the sum is known, and what is not known in it is not known when read back', () => {
    // Known in a box of the grid less one corner of that box: so not a box.
    const inBox = ([i, j, k]: Vec3): boolean => i >= 2 && i <= 5 && j >= 1 && j <= 4 && k >= 1;
    const isKnown = (index: Vec3): boolean =>
      inBox(index) && !(index[0] >= 4 && index[1] >= 3 && index[2] >= 3);
    const sum = sumOn(ASKEW, EQD2, ramp, isKnown);
    const written = writeSummedDose(contentOf(sum), { createdAt: AT });
    expect(written.dims).toEqual([4, 4, 4]);
    expect(written.unknownCount).toBe(2 * 2 * 2);

    const read = readBack(written.bytes);
    expect(read.dims).toEqual([4, 4, 4]);
    const corner = placeOf(sum, [2, 1, 1]);
    for (const axis of [0, 1, 2]) expect(read.geometry!.origin[axis]).toBeCloseTo(corner[axis], 9);
    let [knownCount, least, most] = [0, Infinity, -Infinity];
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const from: Vec3 = [i + 2, j + 1, k + 1];
          const voxel = (k * 4 + j) * 4 + i;
          expect(read.known![voxel], String(from)).toBe(isKnown(from) ? 1 : 0);
          if (!isKnown(from)) {
            expect(read.data[voxel]).toBe(0);
            continue;
          }
          knownCount++;
          const value = ramp(from);
          least = Math.min(least, read.data[voxel]);
          most = Math.max(most, read.data[voxel]);
          expect(Math.abs(read.data[voxel] - value)).toBeLessThanOrEqual(near(value, 1e-6) + 1e-6);
        }
      }
    }
    expect(knownCount).toBe(64 - 8);
    // What it spans is what is known: the 0 that stands for "not known" is no part of it.
    expect(read.min).toBe(least);
    expect(read.max).toBe(most);
    expect(read.min).toBeGreaterThan(1);
    expect(read.dose).toMatchObject({ type: 'EFFECTIVE', sum: EQD2 });
  });

  it('places the frames of a grid whose slices go against their normal', () => {
    const base = gridOf([4, 3, 5], [1, 1, 3], [0, 0, 12]);
    const down: ResampleGrid = {
      ...base,
      geometry: { ...base.geometry!, kStep: [0, 0, -3] },
    };
    const sum = sumOn(down, PHYSICAL, ramp);
    const written = writeSummedDose(contentOf(sum), { createdAt: AT });
    const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
    expect(dataSet.string('x3004000c')).toBe('0\\-3\\-6\\-9\\-12');
    expect(dataSet.string('x00200032')).toBe('0\\0\\12');
    // Read back, the frames are in the order of their places: the last written is the first.
    const read = readBack(written.bytes);
    expect(read.geometry!.origin).toEqual([0, 0, 0]);
    for (let k = 0; k < 5; k++) {
      const value = ramp([2, 1, 4 - k]);
      expect(Math.abs(read.data[(k * 3 + 1) * 4 + 2] - value)).toBeLessThanOrEqual(
        near(value, 1e-6),
      );
    }
  });

  it('writes a sum of one frame as a dose that is not multi-frame', () => {
    const sum = sumOn(gridOf([5, 4, 1], [2, 2, 3], [1, 2, 3]), PHYSICAL, ramp);
    const written = writeSummedDose(contentOf(sum), { createdAt: AT });
    const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
    for (const tag of ['x00280008', 'x00280009', 'x3004000c']) {
      expect(dataSet.elements[tag], tag).toBeUndefined();
    }
    const read = readBack(written.bytes);
    expect(read.dims).toEqual([5, 4, 1]);
    expect(read.dose?.frameOffsets).toBe('single');
    expect(Math.abs(read.data[7] - sum.data[7])).toBeLessThanOrEqual(near(sum.data[7], 1e-6));
  });

  it('scales by a millionth of a gray, or the least power of ten that holds the greatest value', () => {
    const grid = gridOf([3, 2, 2], [1, 1, 1], [0, 0, 0]);
    const cases: [number, number][] = [
      [4294.9, 1e-6],
      [4295, 1e-5],
      [65000, 1e-4],
      [5e9, 10],
    ];
    for (const [greatest, scaling] of cases) {
      const sum = sumOn(grid, PHYSICAL, ([i, j, k]) => (i + j + k === 4 ? greatest : 0.5 * i));
      const written = writeSummedDose(contentOf(sum), { createdAt: AT });
      expect(written.scaling, String(greatest)).toBe(scaling);
      const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
      expect(Number(dataSet.string('x3004000e'))).toBe(scaling);
      const read = readBack(written.bytes);
      expect(Math.abs(read.max - Math.fround(greatest))).toBeLessThanOrEqual(
        near(greatest, scaling),
      );
    }
  });

  it('says what an RT Dose must, as a dose of 32 unsigned bits in gray', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const written = writeSummedDose(contentOf(sum, { seriesNumber: 7 }), {
      createdAt: AT,
      sopInstanceUid: '2.25.1',
      seriesInstanceUid: '2.25.2',
    });
    expect(written).toMatchObject({ sopInstanceUid: '2.25.1', seriesInstanceUid: '2.25.2' });
    const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
    const said = (tag: string): string | undefined => dataSet.string(tag);
    expect(said('x00020002')).toBe(RT_DOSE_SOP_CLASS);
    expect(said('x00020010')).toBe('1.2.840.10008.1.2.1');
    // Written in UTF-8, and it says so (#249).
    expect(said('x00080005')).toBe('ISO_IR 192');
    expect(said('x00080008')).toBe('DERIVED\\SECONDARY');
    expect(said('x00080016')).toBe(RT_DOSE_SOP_CLASS);
    expect(said('x00080018')).toBe('2.25.1');
    expect(said('x00080060')).toBe('RTDOSE');
    expect(said('x00080070')).toBe('Open RT Studio');
    expect(said('x00080012')).toBe('20261115');
    expect(said('x00080013')).toBe('093005');
    expect(said('x00080020')).toBe('20260105');
    expect(said('x00081030')).toBe('Synthetic planning study');
    expect(said('x0008103e')).toBe('Summed dose: physical, 2 doses');
    expect(said('x00100010')).toBe('SYNTHETIC^PHANTOM');
    expect(said('x00100020')).toBe('SYN-001');
    expect(said('x0020000d')).toBe('1.2.826.0.1.3680043.8.498.41');
    expect(said('x0020000e')).toBe('2.25.2');
    expect(said('x00200011')).toBe('7');
    expect(said('x00200052')).toBe('1.2.826.0.1.3680043.8.498.31');
    expect(dataSet.uint16('x00280002')).toBe(1);
    expect(said('x00280004')).toBe('MONOCHROME2');
    expect(said('x00280008')).toBe('5');
    // Frame Increment Pointer names Grid Frame Offset Vector.
    expect([dataSet.uint16('x00280009', 0), dataSet.uint16('x00280009', 1)]).toEqual([
      0x3004, 0x000c,
    ]);
    expect(dataSet.uint16('x00280010')).toBe(6);
    expect(dataSet.uint16('x00280011')).toBe(7);
    expect(said('x00280030')).toBe('2\\1.5');
    expect(dataSet.uint16('x00280100')).toBe(32);
    expect(dataSet.uint16('x00280101')).toBe(32);
    expect(dataSet.uint16('x00280102')).toBe(31);
    expect(dataSet.uint16('x00280103')).toBe(0);
    expect(said('x30040002')).toBe('GY');
    expect(said('x30040004')).toBe('PHYSICAL');
    expect(said('x30040006')).toBe('Summed in Open RT Studio. Not for clinical use.');
    expect(said('x3004000c')).toBe('0\\2.5\\5\\7.5\\10');
    expect(said('x3004000e')).toBe('0.000001');
    expect(dataSet.elements['x7fe00010'].length).toBe(7 * 6 * 5 * 4);
    expect(said('x30050010')).toBe(SUM_RECORD_CREATOR);
    // Known everywhere: there is no record of where.
    expect(dataSet.elements['x30051001']).toBeUndefined();
    expect(parseDoseSumMade(said('x30051002')!)).toEqual(PHYSICAL);

    // Every element after the one before it, and every value of an even length.
    // (The parser lists the file's own header, group 0002, after the rest.)
    const tags = Object.keys(dataSet.elements).filter((tag) => !tag.startsWith('x0002'));
    expect(tags).toEqual([...tags].sort());
    for (const tag of tags) expect(dataSet.elements[tag].length % 2, tag).toBe(0);
  });

  it('says in the standard’s codes that it is derived, of which doses, and through what', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const written = writeSummedDose(contentOf(sum), { createdAt: AT });
    const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
    // Its header says it is derived, by which a timeline marks it (#254).
    const header = readInstanceHeader(new Uint8Array(written.bytes));
    expect(header.ok && header.header.derived).toBe(true);
    const sources = items(dataSet, 'x0008114a');
    expect(sources.map((item) => item.string('x00081155'))).toEqual([DOSE_A, DOSE_B]);
    for (const item of sources) {
      expect(item.string('x00081150')).toBe(RT_DOSE_SOP_CLASS);
      expect(codes(item, 'x0040a170')).toEqual([
        '121372 DCM Source dose for composing current dose',
      ]);
    }
    expect(codes(dataSet, 'x00089215')).toEqual(['121370 DCM Composed from prior doses']);
    expect(codes(dataSet, 'x30040021')).toEqual(['131400 DCM Radiation Dose']);
    expect(codes(items(dataSet, 'x30040021')[0], 'x30040022')).toEqual([
      '131406 DCM Spatially Transformed Dose',
      '131407 DCM Derived Dose',
    ]);
    expect(dataSet.string('x30040005')).toBe('RIGID');
    expect(
      items(dataSet, 'x00700404').map((item) => [
        item.string('x00081150'),
        item.string('x00081155'),
      ]),
    ).toEqual([['1.2.840.10008.5.1.4.1.1.66.1', REGISTRATION]]);
    const effect = items(dataSet, 'x30040023');
    expect(effect).toHaveLength(1);
    expect(effect[0].string('x30100002')).toBe('NO');
    for (const tag of ['x30100003', 'x30100004', 'x30100005']) {
      expect(effect[0].elements[tag], tag).toBeUndefined();
    }
    expect(dataSet.string('x00082111')).toBe(
      'Made with Open RT Studio. Not for clinical use. Sum of 2 doses.',
    );
  });

  it('says a converted sum is an effective dose, and by what model', () => {
    const made: DoseSumMade = { doses: 3, model: 'eqd', fractionGy: 2, alphaBetaGy: null };
    const written = writeSummedDose(contentOf(sumOn(ASKEW, made, ramp)), { createdAt: AT });
    const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
    expect(written.seriesDescription).toBe('Summed dose: EQD2 (alpha/beta by voxel)');
    expect(dataSet.string('x0008103e')).toBe(written.seriesDescription);
    expect(dataSet.string('x30040004')).toBe('EFFECTIVE');
    expect(codes(dataSet, 'x00089215')).toEqual([
      '121370 DCM Composed from prior doses',
      '121377 DCM Composed with radiobiological effects',
    ]);
    const [effect] = items(dataSet, 'x30040023');
    expect(effect.string('x30100002')).toBe('YES');
    expect(codes(effect, 'x30100003')).toEqual([
      '130127 DCM Fractionation-based or temporally-based methods',
    ]);
    expect(codes(effect, 'x30100004')).toEqual([
      '130130 DCM Equivalent 2-Gray Fractions Model',
      '130131 DCM Linear-Quadratic Model',
    ]);
    expect(effect.string('x30100005')).toBe('EQD2 (alpha/beta by voxel); linear-quadratic model');
    expect(parseDoseSumMade(dataSet.string('x30051002')!)).toEqual(made);

    // A BED, and an EQD in fractions of another size, are by the model alone.
    for (const other of [
      { doses: 2, model: 'bed', alphaBetaGy: 10 },
      { doses: 2, model: 'eqd', fractionGy: 1.8, alphaBetaGy: 10 },
    ] as DoseSumMade[]) {
      const bytes = writeSummedDose(contentOf(sumOn(ASKEW, other, ramp))).bytes;
      const [said] = items(dicomParser.parseDicom(new Uint8Array(bytes)), 'x30040023');
      expect(codes(said, 'x30100004')).toEqual(['130131 DCM Linear-Quadratic Model']);
    }
    expect(doseSumAsciiName({ doses: 2, model: 'bed', alphaBetaGy: 10 })).toBe(
      'BED (alpha/beta 10 Gy)',
    );
    expect(summedDoseDescription({ doses: 1, model: 'physical' })).toBe(
      'Summed dose: physical, 1 dose',
    );
  });

  it('says how the doses were moved by the furthest any was, and names each registration once', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const said = (sources: SummedDoseSource[]): dicomParser.DataSet =>
      dicomParser.parseDicom(
        new Uint8Array(writeSummedDose(contentOf(sum, { sources }), { createdAt: AT }).bytes),
      );

    // None moved: nothing is said of a transformation.
    const still = said([HERE, { ...HERE, sopInstanceUid: DOSE_B }]);
    expect(still.elements['x30040005']).toBeUndefined();
    expect(still.elements['x00700404']).toBeUndefined();
    expect(codes(items(still, 'x30040021')[0], 'x30040022')).toEqual(['131407 DCM Derived Dose']);

    // Moved by hand: a rigid transformation that is in no object.
    const byHand = said([HERE, { ...MOVED, registrations: [] }]);
    expect(byHand.string('x30040005')).toBe('RIGID');
    expect(byHand.elements['x00700404']).toBeDefined();
    expect(items(byHand, 'x00700404')).toEqual([]);

    // One through a deformation field, two through the same matrix.
    const field = registrationReference('1.2.826.0.1.3680043.8.498.22', true);
    const bent = said([
      MOVED,
      { ...MOVED, sopInstanceUid: DOSE_A },
      { ...MOVED, sopInstanceUid: '2.25.9', registrations: [field], transform: 'non-rigid' },
    ]);
    expect(bent.string('x30040005')).toBe('NON_RIGID');
    expect(items(bent, 'x00700404').map((item) => item.string('x00081155'))).toEqual([
      REGISTRATION,
      field.sopInstanceUid,
    ]);
    expect(codes(bent, 'x00089215')).toEqual([
      '121370 DCM Composed from prior doses',
      '121367 DCM Composed from deformable registration',
    ]);
  });

  it('takes the doses for whole plans’ doses, and says how many name no plan', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const of = (sources: SummedDoseSource[]) => {
      const written = writeSummedDose(contentOf(sum, { sources }), { createdAt: AT });
      const dataSet = dicomParser.parseDicom(new Uint8Array(written.bytes));
      return {
        type: dataSet.string('x3004000a'),
        returned: written.summationType,
        notNamed: written.plansNotNamed,
        plans: items(dataSet, 'x300c0002').map((item) => [
          item.string('x00081150'),
          item.string('x00081155'),
        ]),
        has: !!dataSet.elements['x300c0002'],
      };
    };
    expect(of([HERE, MOVED])).toEqual({
      type: 'MULTI_PLAN',
      returned: 'MULTI_PLAN',
      notNamed: 0,
      plans: [
        [RT_PLAN_SOP_CLASS, PLAN_A],
        [RT_PLAN_SOP_CLASS, PLAN_B],
      ],
      has: true,
    });
    // Two doses of one plan, and one dose alone: a plan's dose.
    expect(of([HERE, { ...MOVED, planUids: [PLAN_A] }])).toMatchObject({
      type: 'PLAN',
      plans: [[RT_PLAN_SOP_CLASS, PLAN_A]],
    });
    expect(of([HERE])).toMatchObject({ type: 'PLAN', notNamed: 0 });
    // A dose that names none is a plan of its own that cannot be named.
    expect(of([HERE, { ...MOVED, planUids: [] }])).toMatchObject({
      type: 'MULTI_PLAN',
      notNamed: 1,
      plans: [[RT_PLAN_SOP_CLASS, PLAN_A]],
    });
    expect(of([{ ...HERE, planUids: [] }])).toEqual({
      type: 'PLAN',
      returned: 'PLAN',
      notNamed: 1,
      plans: [],
      has: false,
    });
    // A dose with no UID of its own is not referred to.
    const unnamed = writeSummedDose(
      contentOf(sum, { sources: [{ ...HERE, sopInstanceUid: null }] }),
    );
    expect(
      dicomParser.parseDicom(new Uint8Array(unnamed.bytes)).elements['x0008114a'],
    ).toBeUndefined();
  });

  it('writes what is said in words as it was given, in UTF-8, no longer than its element may be (#249)', () => {
    const sum = sumOn(ASKEW, PHYSICAL, ramp);
    const long = `α/β “quoted” ${'x'.repeat(1100)}`;
    const written = writeSummedDose(contentOf(sum, { derivationDescription: long }));
    // Read as a file is read here: by the character set it says.
    const [plane] = parseFile('sum.dcm', written.bytes);
    const said = plane.metadata!.derivation!.description!;
    expect(Array.from(said)).toHaveLength(1024);
    expect(said.startsWith('α/β “quoted” xxx')).toBe(true);
  });

  it('refuses what an RT Dose cannot hold, and says why', () => {
    const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);
    const sum = sumOn(grid, PHYSICAL, ramp);
    const refused = (volume: Volume): string => {
      try {
        writeSummedDose(contentOf(volume));
      } catch (error) {
        expect(error).toBeInstanceOf(DoseWriteError);
        return (error as Error).message;
      }
      return 'written';
    };
    expect(refused({ ...sum, dose: { ...sum.dose!, sum: undefined } })).toBe(
      'It is not a dose in gray that was made here by summing.',
    );
    expect(refused({ ...sum, dose: { ...sum.dose!, units: 'RELATIVE' } })).toBe(
      'It is not a dose in gray that was made here by summing.',
    );
    expect(refused({ ...sum, geometry: undefined })).toBe(
      'The sum has no place in the patient to write.',
    );
    const { geometry } = sum;
    expect(refused({ ...sum, geometry: { ...geometry!, jStep: [0.3, 1, 0] } })).toContain(
      'not at right angles',
    );
    // Slices stepped aslant, as a tilted gantry's are.
    expect(refused({ ...sum, geometry: { ...geometry!, kStep: [0, 0.2, 1] } })).toContain(
      'stepped aslant',
    );
    expect(refused({ ...sum, geometry: { ...geometry!, kStep: [0, 0, 0] } })).toContain(
      'a step of no length',
    );
    expect(refused(sumOn(grid, PHYSICAL, ramp, () => false))).toBe(
      'The sum is known nowhere: there is nothing to write.',
    );
    expect(refused(sumOn(grid, PHYSICAL, ([i]) => (i === 2 ? -0.5 : 1)))).toContain(
      'below nothing or is no number',
    );
    expect(refused(sumOn(grid, PHYSICAL, ([i]) => (i === 2 ? Number.NaN : 1)))).toContain(
      'below nothing or is no number',
    );
    // What is not known is not looked at: a value there is no value.
    const hidden = sumOn(grid, PHYSICAL, ramp, ([i]) => i !== 2);
    hidden.data[2] = -5;
    expect(refused(hidden)).toBe('written');
    expect(refused(sumOn(gridOf([65536, 1, 1], [1, 1, 1], [0, 0, 0]), PHYSICAL, () => 1))).toBe(
      'The sum has more rows or columns than a DICOM image may.',
    );
  });
});

describe('the record a written sum keeps of itself', () => {
  it('packs where a sum is known a bit to a voxel, and reads it back', () => {
    const known = Uint8Array.from([1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1]);
    const bits = packKnown(known);
    expect([...bits]).toEqual([0b10111001, 0b110]);
    expect(unpackKnown(bits, 11)).toEqual(known);
    // A byte that pads an odd number of bytes to an even length is allowed.
    expect(unpackKnown(Uint8Array.from([0b101, 0]), 3)).toEqual(Uint8Array.from([1, 0, 1]));
    for (const voxels of [0, 17, 40]) {
      expect(unpackKnown(bits, voxels)).toEqual({
        problem: 'Its record of where the sum is known is not of the size of its grid',
      });
    }
  });

  it('keeps what a sum is, and reads back nothing that does not say all of it', () => {
    const all: DoseSumMade[] = [
      PHYSICAL,
      EQD2,
      { doses: 1, model: 'bed', alphaBetaGy: 2.5 },
      { doses: 4, model: 'eqd', fractionGy: 1.8, alphaBetaGy: null },
      { doses: 4, model: 'bed', alphaBetaGy: null },
    ];
    for (const made of all) expect(parseDoseSumMade(serializeDoseSumMade(made))).toEqual(made);
    // A sum by voxel says so: it is not left out.
    expect(serializeDoseSumMade({ doses: 2, model: 'bed' })).toContain('"alphaBetaGy":null');
    const unread = { problem: 'Its record of what sum it is cannot be read' };
    for (const text of [
      '',
      'null',
      '[]',
      '{"doses":2}',
      '{"doses":0,"model":"physical"}',
      '{"doses":1.5,"model":"physical"}',
      '{"doses":2,"model":"rbe"}',
      '{"doses":2,"model":"bed"}',
      '{"doses":2,"model":"bed","alphaBetaGy":0}',
      '{"doses":2,"model":"bed","alphaBetaGy":"3"}',
      '{"doses":2,"model":"eqd","alphaBetaGy":3}',
      '{"doses":2,"model":"eqd","alphaBetaGy":3,"fractionGy":-2}',
    ]) {
      expect(parseDoseSumMade(text), text).toEqual(unread);
    }
  });

  it('is not read when it does not agree with the dose it is in', () => {
    const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);
    const patched = (from: string, to: string): ArrayBuffer => {
      const bytes = new Uint8Array(writeSummedDose(contentOf(sumOn(grid, PHYSICAL, ramp))).bytes);
      const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
      const at = text.indexOf(from);
      expect(at).toBeGreaterThan(0);
      expect(to).toHaveLength(from.length);
      for (let i = 0; i < to.length; i++) bytes[at + i] = to.charCodeAt(i);
      return bytes.buffer;
    };
    expect(() => parseFile('sum.dcm', patched('"physical"', '"physicol"'))).toThrow(
      'RT Dose not read. Its record of what sum it is cannot be read',
    );
    // Dose Type says EFFECTIVE, the record a physical sum.
    expect(() => parseFile('sum.dcm', patched('PHYSICAL', 'EFFECTIVE'.slice(0, 8)))).toThrow(
      /RT Dose not read\. /,
    );
  });
});
