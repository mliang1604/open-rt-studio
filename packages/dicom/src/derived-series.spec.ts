/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import { describe, expect, it } from 'vitest';

import {
  CT_IMAGE_SOP_CLASS,
  DerivedSeriesError,
  MR_IMAGE_SOP_CLASS,
  SECONDARY_CAPTURE_SOP_CLASS,
  derivedSopClass,
  registrationReference,
  writeDerivedSeries,
  type DerivedSeriesContent,
} from './derived-series.js';
import { readInstanceHeader, saysDerived } from './instance-header.js';
import { parseFile } from './loader.js';
import { imageDerivation } from './metadata.js';
import { rigidMat4, type Mat4 } from './mat4.js';
import { resampleVolume, resampledVolume, type ResampleGrid } from './resample.js';
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

function imageOf(
  grid: ResampleGrid,
  value: (index: Vec3) => number,
  more: Partial<Volume> = {},
): Volume {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * ny * nz);
  let at = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[at++] = value([i, j, k]);
  }
  return {
    ...grid,
    data,
    min: 0,
    max: 0,
    windowCenter: 40,
    windowWidth: 400,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    modality: 'CT',
    ...more,
  } as Volume;
}

/** A source CT, and the same resampled onto a grid of other voxels that lies askew. */
const SOURCE = imageOf(gridOf([12, 10, 8], [1, 1, 2], [-4, 3, 10]), ([i, j, k]) =>
  Math.round(37.3 * i - 21.7 * j + 55.1 * k - 700),
);
const REFERENCE = gridOf(
  [9, 7, 5],
  [0.8, 1.1, 2.5],
  [-3.2, 4.4, 11.5],
  rigidMat4([0.1, -0.2, 1], 12),
);
const RESAMPLED = resampledVolume(
  SOURCE,
  REFERENCE,
  resampleVolume(SOURCE, REFERENCE, null, { interpolation: 'linear', outside: -1000 }).data,
);

const REGISTRATION = registrationReference('1.2.3.70', false);
function contentOf(volume: Volume, more: Partial<DerivedSeriesContent> = {}): DerivedSeriesContent {
  return {
    volume,
    frameOfReferenceUid: '1.2.3.50',
    patientName: 'SYNTHETIC^PHANTOM',
    patientId: 'SYN-0001',
    studyInstanceUid: '1.2.3.10',
    studyDate: '20260316',
    studyTime: '101500',
    studyDescription: 'Follow-up',
    seriesDescription: 'T2 resampled onto Planning CT',
    seriesNumber: 902,
    source: {
      studyInstanceUid: '1.2.3.10',
      seriesInstanceUid: '1.2.3.20',
      sopClassUid: CT_IMAGE_SOP_CLASS,
      attributes: {},
    },
    registrations: [REGISTRATION],
    derivationDescription: 'Resampled through a registration. Not for clinical use.',
    ...more,
  };
}

/** Read a written series back the way files are opened. */
function reload(files: readonly { bytes: ArrayBuffer }[]): Volume {
  // In another order than they were written: a folder gives files in any order.
  const slices = [...files]
    .reverse()
    .flatMap((file, at) => parseFile(`slice-${at}.dcm`, file.bytes));
  return buildVolume(slices);
}

const read = (bytes: ArrayBuffer) => dicomParser.parseDicom(new Uint8Array(bytes));

describe('a resampled image written as a derived series', () => {
  const written = writeDerivedSeries(contentOf(RESAMPLED), {
    createdAt: new Date(2026, 10, 14, 9, 5, 7),
  });

  it('reloads with the same voxels, each rounded to a value the source’s rescale can store', () => {
    expect(written.instances).toHaveLength(5);
    const back = reload(written.instances);
    expect(back.dims).toEqual([9, 7, 5]);
    expect(back.data).toHaveLength(RESAMPLED.data.length);
    let [exact, most] = [0, 0];
    for (let at = 0; at < back.data.length; at++) {
      // Slope 1: the nearest whole number.
      expect(back.data[at]).toBe(Math.round(RESAMPLED.data[at]));
      most = Math.max(most, Math.abs(back.data[at] - RESAMPLED.data[at]));
      if (back.data[at] === RESAMPLED.data[at]) exact++;
    }
    expect(most).toBeLessThanOrEqual(0.5);
    // Blending made values between whole numbers; the test is not of whole numbers alone.
    expect(exact).toBeLessThan(back.data.length);
    expect(written.clampedCount).toBe(0);
    expect([back.rescaleSlope, back.rescaleIntercept, back.modality]).toEqual([1, -1024, 'CT']);
    expect([back.windowCenter, back.windowWidth]).toEqual([40, 400]);
  });

  it('reloads on the grid it was resampled onto, askew as it is', () => {
    const back = reload(written.instances);
    const { geometry } = REFERENCE;
    back.spacing.forEach((mm, axis) => expect(mm).toBeCloseTo(REFERENCE.spacing[axis], 5));
    for (const part of ['iStep', 'jStep', 'kStep', 'origin'] as const) {
      back.geometry![part].forEach((value, axis) =>
        expect(value, `${part}[${axis}]`).toBeCloseTo(geometry![part][axis], 5),
      );
    }
  });

  it('says that it is derived, how, from what and through what', () => {
    const [first] = written.instances.map((one) => read(one.bytes));
    expect(first.string('x00080008')).toBe('DERIVED\\SECONDARY\\AXIAL');
    expect(first.string('x00082111')).toBe(
      'Resampled through a registration. Not for clinical use.',
    );
    const [derivation] = first.elements['x00089215'].items!;
    expect([
      derivation.dataSet!.string('x00080100'),
      derivation.dataSet!.string('x00080102'),
      derivation.dataSet!.string('x00080104'),
    ]).toEqual(['113085', 'DCM', 'Spatial resampling']);
    // The series it was resampled from.
    const related = first.elements['x00081250'].items!;
    expect(related).toHaveLength(1);
    expect(related[0].dataSet!.string('x0020000d')).toBe('1.2.3.10');
    expect(related[0].dataSet!.string('x0020000e')).toBe('1.2.3.20');
    // The registration it was resampled through.
    const sources = first.elements['x00420013'].items!;
    expect(sources).toHaveLength(1);
    expect(sources[0].dataSet!.string('x00081150')).toBe('1.2.840.10008.5.1.4.1.1.66.1');
    expect(sources[0].dataSet!.string('x00081155')).toBe('1.2.3.70');
    expect(first.string('x0008103e')).toBe('T2 resampled onto Planning CT');
    expect(first.string('x00080070')).toBe('Open RT Studio');
  });

  it('reads back as a derived image: what it says of how it was made, from what, and when', () => {
    // As the viewer reads a file: the first slice carries the series' metadata.
    const slices = written.instances.flatMap((one, at) => parseFile(`slice-${at}.dcm`, one.bytes));
    const derivation = slices.find((slice) => slice.metadata)!.metadata!.derivation!;
    expect(derivation.description).toBe('Resampled through a registration. Not for clinical use.');
    expect(derivation.relatedSeriesUids).toEqual(['1.2.3.20']);
    expect(derivation.sourceInstanceUids).toEqual(['1.2.3.70']);
    expect(derivation.date).toMatch(/^\d{8}$/);
    expect(derivation.time).toMatch(/^\d{6}/);
    // An image that says nothing of the kind has nothing said of it.
    const plain = dicomParser.parseDicom(new Uint8Array(written.instances[0].bytes));
    delete plain.elements['x00080008'];
    delete plain.elements['x00082111'];
    expect(imageDerivation(plain)).toBeNull();
    // Its header says it too (#254): every slice, and not the image with neither element.
    for (const one of written.instances) {
      const header = readInstanceHeader(new Uint8Array(one.bytes));
      expect(header.ok && header.header.derived).toBe(true);
    }
    expect(saysDerived(plain)).toBe(false);
  });

  it('is in the frame of reference of its grid, in the study and of the patient it was given', () => {
    for (const one of written.instances.map((file) => read(file.bytes))) {
      expect(one.string('x00200052')).toBe('1.2.3.50');
      expect(one.string('x0020000d')).toBe('1.2.3.10');
      expect(one.string('x00100010')).toBe('SYNTHETIC^PHANTOM');
      expect(one.string('x00100020')).toBe('SYN-0001');
      expect(one.string('x00080020')).toBe('20260316');
      expect(one.string('x00080023')).toBe('20261114');
      expect(one.string('x00080033')).toBe('090507');
      expect(one.string('x00200011')).toBe('902');
    }
  });

  it('has UIDs of its own: one series, and an instance to a slice', () => {
    const sets = written.instances.map((file) => read(file.bytes));
    const series = new Set(sets.map((one) => one.string('x0020000e')));
    expect([...series]).toEqual([written.seriesInstanceUid]);
    expect(written.seriesInstanceUid).not.toBe('1.2.3.20');
    expect(written.seriesInstanceUid).toMatch(/^2\.25\.\d+$/);
    const instances = sets.map((one) => one.string('x00080018'));
    expect(new Set(instances).size).toBe(5);
    expect(instances).toEqual(written.instances.map((one) => one.sopInstanceUid));
    expect(sets.map((one) => one.string('x00200013'))).toEqual(['1', '2', '3', '4', '5']);
    // The file's own heading names the same class and instance.
    expect(sets[2].string('x00020003')).toBe(instances[2]);
    expect(sets[2].string('x00020002')).toBe(CT_IMAGE_SOP_CLASS);
    // UIDs that are asked for are the ones written.
    const asked = writeDerivedSeries(contentOf(RESAMPLED), {
      seriesInstanceUid: '1.2.3.99',
      sopInstanceUid: (slice) => `1.2.3.99.${slice + 1}`,
    });
    expect(asked.seriesInstanceUid).toBe('1.2.3.99');
    expect(asked.instances.map((one) => one.sopInstanceUid)).toContain('1.2.3.99.5');
  });

  it('writes its elements in ascending order, as the standard requires', () => {
    // The file's own heading (group 0002) is read apart from the rest.
    const tags = Object.keys(read(written.instances[0].bytes).elements).filter(
      (tag) => !tag.startsWith('x0002'),
    );
    // Its Specific Character Set first among them (#249).
    expect(tags).toHaveLength(49);
    expect(tags[0]).toBe('x00080005');
    expect(tags).toEqual([...tags].sort());
    expect(tags.at(-1)).toBe('x7fe00010');
  });

  it('is a CT image with what the standard requires of one, empty where nothing is known', () => {
    const first = read(written.instances[0].bytes);
    expect(written.sopClassUid).toBe(CT_IMAGE_SOP_CLASS);
    expect(first.string('x00080016')).toBe(CT_IMAGE_SOP_CLASS);
    // KVP, Patient Position and Acquisition Number may be empty, and must be there.
    for (const tag of ['x00180060', 'x00185100', 'x00200012']) {
      expect(first.elements[tag], tag).toBeDefined();
      expect(first.string(tag) ?? '', tag).toBe('');
    }
    expect([first.uint16('x00280002'), first.string('x00280004')]).toEqual([1, 'MONOCHROME2']);
    expect([
      first.uint16('x00280100'),
      first.uint16('x00280101'),
      first.uint16('x00280102'),
    ]).toEqual([16, 16, 15]);
    expect([first.uint16('x00280010'), first.uint16('x00280011')]).toEqual([7, 9]);
    // Between rows, then between columns.
    expect(first.string('x00280030')).toBe('1.1\\0.8');
    expect(first.string('x00180050')).toBe('2.5');
    // Not a Secondary Capture: it does not say how it was converted.
    expect(first.elements['x00080064']).toBeUndefined();
  });
});

describe('the values of a derived series', () => {
  const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);

  it('are signed when some are below what the rescale stores as nothing, and unsigned otherwise', () => {
    // Intercept −1024: a value of −2000 is stored as −976.
    const low = imageOf(grid, ([i]) => (i === 0 ? -2000 : 100));
    const signed = writeDerivedSeries(contentOf(low));
    expect(read(signed.instances[0].bytes).uint16('x00280103')).toBe(1);
    expect(reload(signed.instances).data[0]).toBe(-2000);
    const plain = writeDerivedSeries(contentOf(imageOf(grid, () => 3000)));
    expect(read(plain.instances[0].bytes).uint16('x00280103')).toBe(0);
    expect(reload(plain.instances).data[5]).toBe(3000);
  });

  it('are rounded to the step of the source’s rescale', () => {
    const half = imageOf(grid, ([i, j]) => 10.3 * i + 0.2 * j, {
      rescaleSlope: 0.5,
      rescaleIntercept: 0,
      modality: 'MR',
    });
    const back = reload(writeDerivedSeries(contentOf(half)).instances);
    expect(back.rescaleSlope).toBe(0.5);
    half.data.forEach((value, at) => {
      expect(back.data[at]).toBe(Math.round(value * 2) / 2);
      expect(Math.abs(back.data[at] - value)).toBeLessThanOrEqual(0.25);
    });
  });

  it('are held to what sixteen bits can store, and those that were are counted', () => {
    const wide = imageOf(grid, ([i, j, k]) => (i === 0 && j === 0 ? 1e6 : k === 1 ? -5 : 7), {
      rescaleIntercept: 0,
    });
    wide.data[5] = Number.NaN;
    const written = writeDerivedSeries(contentOf(wide));
    // Two voxels of a million, one that is no number.
    expect(written.clampedCount).toBe(3);
    const back = reload(written.instances);
    expect(back.data[0]).toBe(32767);
    expect(back.data[1]).toBe(7);
    expect(back.data[12 + 1]).toBe(-5);
  });

  it('stores by the slope as it is written, however fine', () => {
    // A slope of more digits than six: 4095 steps of it must come back as stored.
    const slope = 0.000244140625;
    const fine = imageOf(grid, ([i, j, k]) => (i + 4 * j + 12 * k) * 170 * slope + 0.1234567, {
      rescaleSlope: slope,
      rescaleIntercept: 0.1234567,
      modality: 'MR',
    });
    const written = writeDerivedSeries(contentOf(fine));
    expect(read(written.instances[0].bytes).string('x00281053')).toBe('0.000244140625');
    const back = reload(written.instances);
    fine.data.forEach((value, at) => expect(back.data[at]).toBeCloseTo(value, 6));
    expect(written.clampedCount).toBe(0);
  });

  it('takes a rescale that is no number as none', () => {
    const odd = imageOf(grid, () => 12, { rescaleSlope: 0, rescaleIntercept: Number.NaN });
    const back = reload(writeDerivedSeries(contentOf(odd)).instances);
    expect([back.rescaleSlope, back.rescaleIntercept, back.data[0]]).toEqual([1, 0, 12]);
  });
});

describe('the kind of object a derived series is', () => {
  const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);
  const mr = imageOf(grid, () => 100, { modality: 'MR', rescaleIntercept: 0 });
  const source = (sopClassUid: string | null, attributes: Record<string, string> = {}) => ({
    studyInstanceUid: '1.2.3.10',
    seriesInstanceUid: '1.2.3.20',
    sopClassUid,
    attributes,
  });
  const SCAN = {
    '(0018,0020)': 'SE',
    '(0018,0021)': 'SK\\SP',
    '(0018,0023)': '2D',
    '(0018,0080)': '4500',
    '(0018,0081)': '102',
    '(0018,5100)': 'HFS',
    // Not of the scan as the standard lists it: not said again.
    '(0018,1030)': 'A protocol',
  };

  it('is an MR image when the source says how it was scanned, and says it again', () => {
    expect(derivedSopClass(source(MR_IMAGE_SOP_CLASS, SCAN))).toBe(MR_IMAGE_SOP_CLASS);
    const written = writeDerivedSeries(contentOf(mr, { source: source(MR_IMAGE_SOP_CLASS, SCAN) }));
    const first = read(written.instances[0].bytes);
    expect(first.string('x00080016')).toBe(MR_IMAGE_SOP_CLASS);
    expect(first.string('x00080008')).toBe('DERIVED\\SECONDARY\\OTHER');
    expect(first.string('x00180020')).toBe('SE');
    expect(first.string('x00180021')).toBe('SK\\SP');
    expect(first.string('x00180080')).toBe('4500');
    expect(first.string('x00185100')).toBe('HFS');
    // What may be empty and is not known is there, empty.
    expect(first.elements['x00180022']).toBeDefined();
    expect(first.string('x00180091') ?? '').toBe('');
    expect(first.elements['x00181030']).toBeUndefined();
    const tags = Object.keys(first.elements).filter((tag) => !tag.startsWith('x0002'));
    expect(tags).toEqual([...tags].sort());
    expect(reload(written.instances).modality).toBe('MR');
  });

  it('is a Secondary Capture when the source does not say what an MR image must', () => {
    const lacking: Record<string, string>[] = [
      {},
      { '(0018,0020)': 'SE' },
      { ...SCAN, '(0018,0021)': '  ' },
    ];
    for (const attributes of lacking) {
      expect(derivedSopClass(source(MR_IMAGE_SOP_CLASS, attributes))).toBe(
        SECONDARY_CAPTURE_SOP_CLASS,
      );
    }
    const written = writeDerivedSeries(contentOf(mr, { source: source(MR_IMAGE_SOP_CLASS) }));
    const first = read(written.instances[0].bytes);
    expect(written.sopClassUid).toBe(SECONDARY_CAPTURE_SOP_CLASS);
    expect(first.string('x00080008')).toBe('DERIVED\\SECONDARY');
    expect(first.string('x00080064')).toBe('WSD');
    // Nothing of a scan is made up.
    expect(first.elements['x00180020']).toBeUndefined();
    // Where each slice is, is still said, and it reloads as the image it is.
    expect(first.string('x00200037')).toBe('1\\0\\0\\0\\1\\0');
    const back = reload(written.instances);
    expect([back.modality, back.dims, back.data[0]]).toEqual(['MR', [4, 3, 2], 100]);
  });

  it('says what the standard asks of some scans only: of those scans, or when the source has it', () => {
    const tagsOf = (attributes: Record<string, string>) =>
      read(
        writeDerivedSeries(contentOf(mr, { source: source(MR_IMAGE_SOP_CLASS, attributes) }))
          .instances[0].bytes,
      );
    // A spin echo, not gated: neither an inversion time nor a trigger time.
    const plainScan = tagsOf(SCAN);
    expect(plainScan.elements['x00180082']).toBeUndefined();
    expect(plainScan.elements['x00181060']).toBeUndefined();
    // Inversion recovery, gated by the heart: both must be there, empty when not known.
    const gated = tagsOf({ ...SCAN, '(0018,0020)': 'SE\\IR', '(0018,0022)': 'FS\\CG' });
    expect(gated.elements['x00180082']).toBeDefined();
    expect(gated.string('x00180082') ?? '').toBe('');
    expect(gated.elements['x00181060']).toBeDefined();
    // And with their values when the source has them.
    const known = tagsOf({
      ...SCAN,
      '(0018,0020)': 'IR',
      '(0018,0082)': '2200',
      '(0018,1060)': '15.5',
    });
    expect(known.string('x00180082')).toBe('2200');
    expect(known.string('x00181060')).toBe('15.5');
    const tags = Object.keys(known.elements).filter((tag) => !tag.startsWith('x0002'));
    expect(tags).toEqual([...tags].sort());
  });

  it('says again of the scan only what its kind of value allows', () => {
    const odd = {
      ...SCAN,
      '(0018,0022)': 'fat sat; DROP TABLE', // no code string
      '(0018,0080)': '4500 ms', // no number
      '(0018,0091)': '1.5', // no whole number
      '(0018,5100)': 'A_VALUE_FAR_TOO_LONG_FOR_ONE',
    };
    const first = read(
      writeDerivedSeries(contentOf(mr, { source: source(MR_IMAGE_SOP_CLASS, odd) })).instances[0]
        .bytes,
    );
    expect(first.string('x00180020')).toBe('SE');
    for (const tag of ['x00180022', 'x00180080', 'x00180091', 'x00185100']) {
      expect(first.string(tag) ?? '', tag).toBe('');
    }
    // And a required one that is not what it should be is as good as missing.
    expect(
      derivedSopClass(source(MR_IMAGE_SOP_CLASS, { ...SCAN, '(0018,0020)': 'spin echo' })),
    ).toBe(SECONDARY_CAPTURE_SOP_CLASS);
  });

  it('is a Secondary Capture for a source of any other kind, or of no known kind', () => {
    expect(derivedSopClass(source(null))).toBe(SECONDARY_CAPTURE_SOP_CLASS);
    expect(derivedSopClass(source('1.2.840.10008.5.1.4.1.1.128'))).toBe(
      SECONDARY_CAPTURE_SOP_CLASS,
    );
    expect(derivedSopClass(source(CT_IMAGE_SOP_CLASS))).toBe(CT_IMAGE_SOP_CLASS);
    const unnamed = imageOf(grid, () => 1, { modality: null });
    const first = read(
      writeDerivedSeries(contentOf(unnamed, { source: source(null) })).instances[0].bytes,
    );
    expect(first.string('x00080060')).toBe('OT');
  });
});

describe('what a derived series refers to', () => {
  const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);
  const image = imageOf(grid, () => 0);

  it('names each registration it went through, by its kind', () => {
    const field = registrationReference('1.2.3.71', true);
    expect(field.sopClassUid).toBe('1.2.840.10008.5.1.4.1.1.66.3');
    const written = writeDerivedSeries(contentOf(image, { registrations: [REGISTRATION, field] }));
    const items = read(written.instances[1].bytes).elements['x00420013'].items!;
    expect(items.map((item) => item.dataSet!.string('x00081155'))).toEqual([
      '1.2.3.70',
      '1.2.3.71',
    ]);
    expect(items[1].dataSet!.string('x00081150')).toBe('1.2.840.10008.5.1.4.1.1.66.3');
  });

  it('names none when it went through none that is an object: one made by hand', () => {
    const written = writeDerivedSeries(contentOf(image, { registrations: [] }));
    const first = read(written.instances[0].bytes);
    expect(first.elements['x00420013']).toBeUndefined();
    // The words still say how it was made.
    expect(first.string('x00082111')).toContain('Resampled');
  });

  it('leaves the source series out when its study is not known, since the standard wants both', () => {
    const written = writeDerivedSeries(
      contentOf(image, {
        source: {
          studyInstanceUid: null,
          seriesInstanceUid: '1.2.3.20',
          sopClassUid: CT_IMAGE_SOP_CLASS,
          attributes: {},
        },
      }),
    );
    expect(read(written.instances[0].bytes).elements['x00081250']).toBeUndefined();
  });

  it('is written in UTF-8 and says so, with the text it was given, whatever it was read in (#249)', () => {
    const written = writeDerivedSeries(
      contentOf(image, {
        patientName: 'Müller^Zoë 山田',
        seriesDescription: 'Resampled: T2 → Planung für 中',
        derivationDescription: 'Resampled.\nLine two — dash',
      }),
    );
    const bytes = new Uint8Array(written.instances[0].bytes);
    const raw = read(written.instances[0].bytes);
    expect(raw.string('x00080005')).toBe('ISO_IR 192');
    // The name is in UTF-8: the parser, a byte to a character, sees its bytes.
    const name = raw.elements['x00100010'];
    expect(
      new TextDecoder()
        .decode(bytes.subarray(name.dataOffset, name.dataOffset + name.length))
        .trim(),
    ).toBe('Müller^Zoë 山田');
    // Read as a file is read here, the text is what was given.
    const header = readInstanceHeader(bytes);
    expect(header.ok && header.header.patient.name).toBe('Müller^Zoë 山田');
    expect(header.ok && header.header.series.description).toBe('Resampled: T2 → Planung für 中');
    const [slice] = parseFile('slice.dcm', written.instances[0].bytes);
    // A character that prints nothing is no part of what is written.
    expect(slice.metadata?.derivation?.description).toBe('Resampled.?Line two — dash');
  });

  it('writes no more of a description than the standard allows', () => {
    const written = writeDerivedSeries(
      contentOf(image, {
        derivationDescription: 'x'.repeat(2000),
        seriesDescription: 'y'.repeat(100),
        seriesNumber: null,
        patientName: null,
        studyDescription: null,
      }),
    );
    const first = read(written.instances[0].bytes);
    expect(first.string('x00082111')).toHaveLength(1024);
    expect(first.string('x0008103e')).toHaveLength(64);
    expect(first.string('x00200011') ?? '').toBe('');
    expect(first.string('x00100010') ?? '').toBe('');
    expect(first.elements['x00081030']).toBeUndefined();
  });
});

describe('a grid DICOM slices cannot lie on', () => {
  const grid = gridOf([4, 3, 2], [1, 1, 1], [0, 0, 0]);

  it('is refused: no place in the patient, rows and columns askew, a step of no length', () => {
    const image = imageOf(grid, () => 0);
    expect(() => writeDerivedSeries(contentOf({ ...image, geometry: undefined }))).toThrow(
      DerivedSeriesError,
    );
    const askew = { ...image, geometry: { ...grid.geometry!, jStep: [0.5, 1, 0] as Vec3 } };
    expect(() => writeDerivedSeries(contentOf(askew))).toThrow(
      'The image’s rows and columns are not at right angles: DICOM slices cannot lie so.',
    );
    const flat = { ...image, geometry: { ...grid.geometry!, kStep: [0, 0, 0] as Vec3 } };
    expect(() => writeDerivedSeries(contentOf(flat))).toThrow('a step of no length');
  });

  it('is not one whose slices are stepped aslant: each slice says where it is', () => {
    // A gantry tilted: the slices are 2 mm apart and each 1 mm further back.
    const tilted = imageOf(
      { ...grid, geometry: { ...grid.geometry!, kStep: [0, 1, 2] as Vec3 } },
      ([i, j, k]) => i + 10 * j + 100 * k,
    );
    const written = writeDerivedSeries(contentOf(tilted));
    const second = read(written.instances[1].bytes);
    expect(second.string('x00200032')).toBe('0\\1\\2');
    // How far apart the slices' planes are, not how long the step is.
    expect(second.string('x00180050')).toBe('2');
  });
});
