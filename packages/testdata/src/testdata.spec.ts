/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  addSeriesToCatalog,
  buildVolume,
  framesMatch,
  groupSeries,
  parseFile,
  parseFileAsync,
  parseStructureSet,
  structureSetsForSeries,
  UnsupportedDicomError,
  type PatientCatalogMap,
  type Slice,
} from '@open-rt-studio/dicom';

import {
  frameOfReferenceUid,
  seriesUid,
  studyUid,
  SYNTHETIC_DOSE_GEOMETRY,
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_FRAME_OF_REFERENCE,
  SYNTHETIC_PATIENT,
  SYNTHETIC_STUDY,
  SYNTHETIC_UID_ROOT,
  SYNTHETIC_UNREADABLE,
  syntheticCtSeries,
  syntheticCtValue,
  syntheticDoseGy,
  syntheticMrSeries,
  syntheticMrValue,
  syntheticPatient,
  syntheticRois,
  syntheticRtDose,
  syntheticRtStruct,
  type SyntheticFile,
  syntheticUnreadableFiles,
} from './index.js';

/** The exact bytes of a file as a standalone ArrayBuffer, as the loader takes them. */
function buffer(file: SyntheticFile): ArrayBuffer {
  return file.bytes.slice().buffer;
}

function parseAll(files: readonly SyntheticFile[]): Slice[] {
  return files.flatMap((f) => parseFile(f.name, buffer(f)));
}

describe('every generated file', () => {
  const files = [...syntheticPatient(), syntheticRtStruct(), syntheticRtDose()];

  it('is a Part 10 file with the DICM marker', () => {
    for (const f of files) {
      expect(String.fromCharCode(...f.bytes.subarray(128, 132)), f.name).toBe('DICM');
      expect(f.bytes.length % 2, f.name).toBe(0);
      expect(f.mimeType).toBe('application/dicom');
    }
  });

  it('is generated identically on every call', () => {
    const again = [...syntheticPatient(), syntheticRtStruct(), syntheticRtDose()];
    expect(again.map((f) => f.name)).toEqual(files.map((f) => f.name));
    again.forEach((f, i) => expect(f.bytes, f.name).toEqual(files[i].bytes));
  });

  it('has a unique file name within a batch', () => {
    const names = syntheticPatient().map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('carries only the synthetic identity', () => {
    for (const slice of parseAll(syntheticPatient())) {
      expect(slice.patientId).toBe(SYNTHETIC_PATIENT.id);
      expect(slice.patientName).toBe(SYNTHETIC_PATIENT.name);
    }
  });
});

describe('synthetic UIDs', () => {
  const VALID_UID = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/;

  it('are valid DICOM UIDs under the synthetic root', () => {
    const uids = [
      studyUid(SYNTHETIC_STUDY),
      studyUid(SYNTHETIC_FOLLOW_UP_STUDY),
      frameOfReferenceUid(SYNTHETIC_STUDY),
      seriesUid(SYNTHETIC_STUDY, 1),
      seriesUid(SYNTHETIC_FOLLOW_UP_STUDY, 20),
    ];
    for (const uid of uids) {
      expect(uid).toMatch(VALID_UID);
      expect(uid.length).toBeLessThanOrEqual(64);
      expect(uid.startsWith(`${SYNTHETIC_UID_ROOT}.`)).toBe(true);
    }
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('give each study its own frame of reference', () => {
    expect(frameOfReferenceUid(SYNTHETIC_STUDY)).toBe(SYNTHETIC_FRAME_OF_REFERENCE);
    expect(frameOfReferenceUid(SYNTHETIC_FOLLOW_UP_STUDY)).not.toBe(SYNTHETIC_FRAME_OF_REFERENCE);
  });
});

describe('syntheticCtSeries', () => {
  it('parses into one series with the requested size', () => {
    const series = groupSeries(parseAll(syntheticCtSeries(10, 16)));
    expect(series).toHaveLength(1);
    expect(series[0].modality).toBe('CT');
    expect(series[0].imageCount).toBe(10);
    expect(series[0].dims).toEqual([16, 16]);
    expect(series[0].uid).toBe(seriesUid(SYNTHETIC_STUDY, 1));
    expect(series[0].studyUid).toBe(studyUid(SYNTHETIC_STUDY));
    expect(series[0].frameOfReferenceUid).toBe(SYNTHETIC_FRAME_OF_REFERENCE);
  });

  it('builds a volume whose voxels follow syntheticCtValue', () => {
    const size = 16;
    const volume = buildVolume(parseAll(syntheticCtSeries(10, size)));
    expect(volume.dims).toEqual([size, size, 10]);
    expect(volume.spacing).toEqual([1, 1, 1]);
    for (const [x, y, z] of [
      [0, 0, 0],
      [15, 0, 0],
      [7, 9, 4],
      [15, 15, 9],
    ]) {
      expect(volume.data[z * size * size + y * size + x]).toBe(syntheticCtValue(x, z, size));
    }
    expect(volume.min).toBe(0);
    expect(volume.max).toBe(syntheticCtValue(size - 1, 9, size));
  });

  it('honours the origin and study options', () => {
    const files = syntheticCtSeries(3, 8, {
      study: SYNTHETIC_FOLLOW_UP_STUDY,
      origin: [5, -3, 20],
    });
    const slices = parseAll(files);
    expect(slices.map((s) => s.position)).toEqual([
      [5, -3, 20],
      [5, -3, 21],
      [5, -3, 22],
    ]);
    expect(slices[0].studyDate).toBe(SYNTHETIC_FOLLOW_UP_STUDY.date);
  });
});

describe('syntheticMrSeries', () => {
  it('is a separate series in the same frame of reference as the CT', () => {
    const [ct] = groupSeries(parseAll(syntheticCtSeries()));
    const [mr] = groupSeries(parseAll(syntheticMrSeries()));
    expect(mr.modality).toBe('MR');
    expect(mr.uid).not.toBe(ct.uid);
    expect(mr.frameOfReferenceUid).toBe(ct.frameOfReferenceUid);
  });

  it('builds a volume whose voxels follow syntheticMrValue', () => {
    const size = 16;
    const volume = buildVolume(parseAll(syntheticMrSeries(4, size)));
    for (const [x, y, z] of [
      [0, 0, 0],
      [8, 7, 0],
      [3, 12, 3],
    ]) {
      expect(volume.data[z * size * size + y * size + x]).toBe(syntheticMrValue(x, y, z, size));
    }
    // Brightest in the middle, dark in the corners: unlike the CT ramp.
    expect(syntheticMrValue(8, 8, 0, size)).toBeGreaterThan(syntheticMrValue(0, 0, 0, size));
  });
});

describe('syntheticRtStruct', () => {
  it('parses into the ROIs that syntheticRois describes', () => {
    const file = syntheticRtStruct(12, 3);
    const parsed = parseStructureSet(file.name, buffer(file));
    const expected = syntheticRois(12, 3);
    expect(parsed).not.toBeNull();
    expect(parsed!.label).toBe('Synthetic Plan');
    expect(parsed!.frameOfReferenceUid).toBe(SYNTHETIC_FRAME_OF_REFERENCE);
    expect(parsed!.rois.map((r) => r.name)).toEqual(expected.map((r) => r.name));
    expect(parsed!.rois.map((r) => r.color)).toEqual(expected.map((r) => r.color));
    expect(parsed!.rois.map((r) => r.interpretedType)).toEqual(expected.map((r) => r.type));
  });

  it('writes closed circles of the stated centre and radius', () => {
    const file = syntheticRtStruct(12);
    const parsed = parseStructureSet(file.name, buffer(file))!;
    const [gtv] = syntheticRois(12);
    const roi = parsed.rois[0];
    expect(roi.contours).toHaveLength(gtv.zs.length);
    expect(roi.contours.map((c) => c.points[0][2])).toEqual(gtv.zs);
    for (const contour of roi.contours) {
      expect(contour.geometricType).toBe('CLOSED_PLANAR');
      for (const [x, y] of contour.points) {
        expect(Math.hypot(x - gtv.center[0], y - gtv.center[1])).toBeCloseTo(gtv.radius, 6);
      }
    }
  });

  it('associates with the CT of its study and not with the follow-up CT', () => {
    const file = syntheticRtStruct();
    const structureSet = parseStructureSet(file.name, buffer(file))!;
    const [ct] = groupSeries(parseAll(syntheticCtSeries()));
    const [followUp] = groupSeries(
      parseAll(syntheticCtSeries(12, 32, { study: SYNTHETIC_FOLLOW_UP_STUDY })),
    );
    expect(structureSetsForSeries([structureSet], ct)).toHaveLength(1);
    expect(structureSetsForSeries([structureSet], followUp)).toHaveLength(0);
  });

  it('is not mistaken for an image', () => {
    const file = syntheticRtStruct();
    expect(parseFile(file.name, buffer(file))).toEqual([]);
  });
});

describe('syntheticRtDose', () => {
  it('parses into a dose volume in Gy with the stated values', () => {
    const frames = 6;
    const size = 12;
    const file = syntheticRtDose(frames, size);
    const slices = parseFile(file.name, buffer(file));
    expect(slices).toHaveLength(frames);
    expect(slices[0].modality).toBe('RTDOSE');
    expect(slices[0].position).toEqual([...SYNTHETIC_DOSE_GEOMETRY.origin]);
    expect(slices[0].pixelSpacing).toEqual([...SYNTHETIC_DOSE_GEOMETRY.pixelSpacing]);

    const volume = buildVolume(slices);
    expect(volume.dims).toEqual([size, size, frames]);
    for (const [c, r, f] of [
      [0, 0, 0],
      [11, 0, 0],
      [3, 7, 2],
      [11, 11, 5],
    ]) {
      expect(volume.data[f * size * size + r * size + c]).toBeCloseTo(syntheticDoseGy(c, r, f), 4);
    }
  });

  it('shares the frame of reference of the CT so it can be overlaid', () => {
    const ct = buildVolume(parseAll(syntheticCtSeries()));
    const dose = syntheticRtDose();
    const [doseSeries] = groupSeries(parseFile(dose.name, buffer(dose)));
    const [ctSeries] = groupSeries(parseAll(syntheticCtSeries()));
    expect(framesMatch(ctSeries.frameOfReferenceUid, doseSeries.frameOfReferenceUid)).toBe(true);
    expect(ct.geometry).toBeDefined();
  });
});

describe('syntheticPatient', () => {
  it('is one patient with two studies, oldest first', () => {
    const empty: PatientCatalogMap = new Map();
    const catalog = addSeriesToCatalog(empty, groupSeries(parseAll(syntheticPatient())));
    expect([...catalog.keys()]).toHaveLength(1);
    const [patient] = [...catalog.values()];
    expect(patient.patientId).toBe(SYNTHETIC_PATIENT.id);
    expect(patient.studies.map((s) => s.date).sort()).toEqual([
      SYNTHETIC_STUDY.date,
      SYNTHETIC_FOLLOW_UP_STUDY.date,
    ]);
    const planning = patient.studies.find((s) => s.date === SYNTHETIC_STUDY.date)!;
    expect([...planning.modalities].sort()).toEqual(['CT', 'MR', 'RTDOSE']);
    const followUp = patient.studies.find((s) => s.date === SYNTHETIC_FOLLOW_UP_STUDY.date)!;
    expect(followUp.modalities).toEqual(['CT']);
  });
});

describe('syntheticUnreadableFiles', () => {
  const files = syntheticUnreadableFiles();

  it('are Part 10 files named as SYNTHETIC_UNREADABLE lists them', () => {
    expect(files.map((f) => f.name)).toEqual(SYNTHETIC_UNREADABLE.map((u) => u.name));
    for (const f of files) {
      expect(String.fromCharCode(...f.bytes.subarray(128, 132)), f.name).toBe('DICM');
      expect(f.bytes.length % 2, f.name).toBe(0);
    }
  });

  it('are refused by the DICOM package for the reason stated', async () => {
    for (const [i, f] of files.entries()) {
      const error: unknown = await parseFileAsync(f.name, buffer(f)).catch((e: unknown) => e);
      expect(error, f.name).toBeInstanceOf(UnsupportedDicomError);
      expect((error as UnsupportedDicomError).reason).toBe(SYNTHETIC_UNREADABLE[i].reason);
      expect((error as UnsupportedDicomError).message).toContain(`(${f.name})`);
    }
  });

  it('carry the synthetic identity and no image', () => {
    const text = (f: SyntheticFile) => String.fromCharCode(...f.bytes);
    for (const f of files) {
      expect(text(f)).toContain(SYNTHETIC_PATIENT.id);
      expect(f.bytes.length).toBeLessThan(2000);
    }
  });
});
