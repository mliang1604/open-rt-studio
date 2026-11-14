/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  IDENTITY_MAT4,
  findPlacement,
  manualPlacement,
  targetRegistrationErrorOfMatrix,
  type Layer,
  type LayerPlacement,
  type PlacementField,
  type Roi,
  type Volume,
} from '@open-rt-studio/dicom';
import { vi } from 'vitest';

import { DATA_SOURCE, type PatientHistory } from '../../data-source/data-source';
import { registrationObject, shiftMatrix } from '../../registration-testing';
import type { FieldReport } from '../field-metrics/field-metrics-panel';
import { LandmarkController, type LandmarkRow } from '../landmarks/landmark-controller';
import { LayersController } from '../layers-controller';
import type { ComparisonReport } from '../structure-compare/structure-compare';
import type { ReportPicture, ReportSection } from './registration-report';
import { ReportController, identityOf, imageRows, registrationTables } from './report-controller';

const volumeOf = (modality: string): Volume =>
  ({ dims: [32, 32, 12], spacing: [0.5, 0.5, 2], modality }) as unknown as Volume;
const BASE: Layer = { id: 'ct', role: 'base', modality: 'CT', volume: volumeOf('CT') } as Layer;
const layerOf = (placement?: LayerPlacement): Layer =>
  ({ id: 'mr', role: 'overlay', modality: 'MR', volume: volumeOf('MR'), placement }) as Layer;

/** As a file has it: the compared image's frame mapped into the base's. */
const REGISTRATION = registrationObject(
  '1.2.3.reg',
  'follow-up',
  'planning',
  shiftMatrix(5, -3, 2),
);
function placedBy(...objects: Parameters<typeof findPlacement>[2]): LayerPlacement {
  const found = findPlacement('planning', 'follow-up', objects);
  if (found.kind !== 'placed') throw new Error(found.kind);
  return found.placement;
}
const PLACEMENT = placedBy(REGISTRATION);

const PATIENT: PatientHistory = {
  key: 'p',
  patientId: 'ID-42',
  name: 'DOE^JANE',
  studies: [
    {
      studyUid: '1.2.3.1',
      date: '20260105',
      description: 'Planning',
      modalities: ['CT'],
      series: [
        {
          uid: 'ct',
          seriesNumber: 1,
          description: 'Chest CT',
          modality: 'CT',
          frameOfReferenceUid: 'planning',
          imageCount: 12,
          structureSets: 0,
        },
      ],
    },
    {
      studyUid: '1.2.3.2',
      date: null,
      description: null,
      modalities: ['MR'],
      series: [
        {
          uid: 'mr',
          seriesNumber: 2,
          description: 'T2',
          modality: 'MR',
          frameOfReferenceUid: 'follow-up',
          imageCount: 12,
          structureSets: 0,
        },
      ],
    },
  ],
} as PatientHistory;

const SECTION: ReportSection = { title: 'A section', about: null, tables: [], notes: [] };
const cells = (rows: readonly { name: string; value: string }[]): string[][] =>
  rows.map((row) => [row.name, row.value]);

describe('what the report says of an image', () => {
  it('finds the series a layer was built from among the patient’s', () => {
    expect(identityOf(PATIENT, 'ct')).toEqual({
      patientName: 'DOE^JANE',
      patientId: 'ID-42',
      studyDate: '20260105',
      studyDescription: 'Planning',
      seriesDescription: 'Chest CT',
      seriesUid: 'ct',
    });
    // A series on screen twice has a number after its UID.
    expect(identityOf(PATIENT, 'mr#2')?.seriesUid).toBe('mr');
    expect(identityOf(PATIENT, 'other')).toBeNull();
    expect(identityOf(null, 'ct')).toBeNull();
  });

  it('says only what the image is made of unless identifiers are asked for', () => {
    const identity = identityOf(PATIENT, 'ct');
    expect(cells(imageRows(BASE, identity, 'planning', false))).toEqual([
      ['Modality', 'CT'],
      ['Size', '32 × 32 × 12 voxels of 0.50 × 0.50 × 2.00 mm'],
    ]);
    expect(cells(imageRows(BASE, identity, 'planning', true))).toEqual([
      ['Modality', 'CT'],
      ['Size', '32 × 32 × 12 voxels of 0.50 × 0.50 × 2.00 mm'],
      ['Patient’s name', 'DOE^JANE'],
      ['Patient ID', 'ID-42'],
      ['Study date', '2026-01-05'],
      ['Study', 'Planning'],
      ['Series', 'Chest CT'],
      ['Series Instance UID', 'ct'],
      ['Frame of Reference UID', 'planning'],
    ]);
    // What the files do not say is not a row; the frame is the placement's own.
    expect(
      cells(imageRows(layerOf(), identityOf(PATIENT, 'mr'), 'follow-up', true)).slice(2),
    ).toEqual([
      ['Patient’s name', 'DOE^JANE'],
      ['Patient ID', 'ID-42'],
      ['Series', 'T2'],
      ['Series Instance UID', 'mr'],
      ['Frame of Reference UID', 'follow-up'],
    ]);
    expect(cells(imageRows(layerOf(), null, 'follow-up', true)).slice(2)).toEqual([
      ['Frame of Reference UID', 'follow-up'],
    ]);
  });
});

describe('what the report says of a registration', () => {
  it('names it, says which way it was written and which way it is used, and gives the matrix', () => {
    const [step, matrix] = registrationTables(PLACEMENT, false);
    expect(step.caption).toBe('Registration');
    expect(cells(step.rows)).toEqual([
      ['Name', 'REGISTRATION'],
      ['Kind', 'Matrix (DICOM Spatial Registration)'],
      ['Written', 'from the compared image’s frame to the base image’s frame'],
      ['Used', 'turned round'],
    ]);
    // The base's frame to the compared image's: the file's matrix turned round.
    expect(matrix.caption).toBe('Base image’s frame to the compared image’s, as a matrix (mm)');
    expect(cells(matrix.rows)).toEqual([
      ['Row 1', '1.0000   0.0000   0.0000   -5.0000'],
      ['Row 2', '0.0000   1.0000   0.0000   3.0000'],
      ['Row 3', '0.0000   0.0000   1.0000   -2.0000'],
      ['Row 4', '0.0000   0.0000   0.0000   1.0000'],
    ]);
  });

  it('gives its UID only with identifiers', () => {
    expect(JSON.stringify(registrationTables(PLACEMENT, false))).not.toContain('1.2.3.reg');
    expect(cells(registrationTables(PLACEMENT, true)[0].rows).at(-1)).toEqual([
      'SOP Instance UID',
      '1.2.3.reg',
    ]);
  });

  it('numbers registrations gone through in a row', () => {
    const chain = placedBy(
      registrationObject('a', 'planning', 'between'),
      registrationObject('b', 'between', 'follow-up'),
    );
    const tables = registrationTables(chain, false);
    expect(tables.map((table) => table.caption)).toEqual([
      'Registration 1 of 2',
      'Registration 2 of 2',
      'Base image’s frame to the compared image’s, as a matrix (mm)',
    ]);
    expect(cells(tables[0].rows)[2]).toEqual([
      'Written',
      'from the base image’s frame to another frame of reference',
    ]);
    expect(cells(tables[0].rows)[3]).toEqual(['Used', 'as written']);
  });

  it('says of one made by hand that it is not from a file, with or without identifiers', () => {
    const byHand = manualPlacement('planning', 'follow-up', shiftMatrix(1, 0, 0));
    const [step] = registrationTables(byHand, true);
    expect(cells(step.rows)).toEqual([
      ['Name', 'none: not from a file'],
      ['Kind', 'Made by hand in the viewer'],
    ]);
  });

  it('gives a field’s grid in place of a matrix', () => {
    const field = {
      pre: IDENTITY_MAT4,
      post: IDENTITY_MAT4,
      grid: { dims: [17, 17, 7], spacing: [2, 2, 2.5] },
    } as unknown as PlacementField;
    const through: LayerPlacement = {
      ...PLACEMENT,
      steps: [{ ...PLACEMENT.steps[0], inverted: false, deformable: true }],
      field,
    };
    const [step, grid] = registrationTables(through, false);
    expect(cells(step.rows)[1]).toEqual([
      'Kind',
      'Deformation field (DICOM Deformable Spatial Registration)',
    ]);
    expect(cells(grid.rows)).toEqual([
      ['Grid', '17 × 17 × 7 vectors'],
      ['Between vectors', '2.00 × 2.00 × 2.50 mm'],
      ['Maps', 'from the base image’s frame to the compared image’s'],
    ]);
  });
});

describe('ReportController', () => {
  afterEach(() => TestBed.resetTestingModule());

  const ROI_A = { name: 'A' } as Roi;
  const ROI_B = { name: 'B' } as Roi;
  const ROWS: LandmarkRow[] = [
    {
      id: 1,
      name: 'Carina',
      hasFixed: true,
      hasMoving: true,
      active: false,
      distanceMm: 3,
      error: [3, 0, 0],
    },
  ];
  const ERROR = targetRegistrationErrorOfMatrix(
    [{ name: 'Carina', fixed: [0, 0, 0], moving: [3, 0, 0] }],
    IDENTITY_MAT4,
  );
  const NO_ERROR = targetRegistrationErrorOfMatrix([], IDENTITY_MAT4);

  function setup(placement: LayerPlacement | null = PLACEMENT) {
    const overlay = signal<Layer | null>(layerOf(placement ?? undefined));
    const volume = signal<Volume | null>(BASE.volume);
    const field = signal<PlacementField | null>(placement?.field ?? null);
    const rows = signal<LandmarkRow[]>([]);
    const error = signal(NO_ERROR);
    const structures = signal<readonly Roi[]>([ROI_A, ROI_B]);
    const pictures = vi.fn<() => Promise<readonly ReportPicture[]>>(() =>
      Promise.resolve([{ caption: 'Axial', dataUrl: 'data:image/png;base64,AAAA' }]),
    );
    const download = vi.fn<(blob: Blob, filename: string) => void>();
    TestBed.configureTestingModule({
      providers: [
        ReportController,
        {
          provide: LayersController,
          useValue: {
            selectedOverlay: overlay,
            volume,
            selectedField: field,
            layers: () => [BASE, ...(overlay() ? [overlay()!] : [])],
          },
        },
        {
          provide: LandmarkController,
          useValue: {
            rows,
            error,
            registration: () => 'Placed by registration “REGISTRATION”',
            measuredIn: () => 'fixed',
          },
        },
        { provide: DATA_SOURCE, useValue: { currentPatient: () => PATIENT } },
      ],
    });
    const controller = TestBed.inject(ReportController);
    controller.init({
      structures,
      pictures,
      now: () => new Date(2026, 10, 4, 9, 5, 7),
      download,
    });
    const measured = (): string[] =>
      controller
        .partStates()
        .filter((part) => part.measured)
        .map((part) => part.key);
    return {
      controller,
      overlay,
      volume,
      field,
      rows,
      error,
      structures,
      pictures,
      download,
      measured,
    };
  }

  it('is of a registration: there is none to make without one that places the compared image', () => {
    expect(setup().controller.available()).toBe(true);
    TestBed.resetTestingModule();
    // Both images in one frame of reference: no registration.
    const { controller, overlay, download } = setup(null);
    expect(controller.available()).toBe(false);
    expect(controller.content([], new Date())).toBeNull();
    void controller.save();
    expect(download).not.toHaveBeenCalled();
    overlay.set(null);
    expect(controller.available()).toBe(false);
  });

  it('has a place for each kind of measurement, filled when it has been made', () => {
    const { controller, rows, error, measured } = setup();
    expect(controller.partStates()).toEqual([
      { key: 'landmarks', title: 'Landmarks: target registration error', measured: false },
      { key: 'structures', title: 'Structures: surface distances and overlap', measured: false },
      { key: 'field', title: 'Deformation field', measured: false },
    ]);
    rows.set(ROWS);
    error.set(ERROR);
    expect(measured()).toEqual(['landmarks']);
    const [landmarks] = controller.parts();
    expect(landmarks.section!.tables.map((table) => table.caption)).toEqual([
      'Target registration error',
      'At each landmark',
    ]);
    expect(landmarks.section!.notes[0]).toBe('Placed by registration “REGISTRATION”.');
  });

  it('reports a comparison of structures only of the image and the structures there are now', () => {
    const { controller, volume, structures, measured } = setup();
    const comparison: ComparisonReport = {
      volume: BASE.volume,
      rois: [ROI_A, ROI_B],
      section: SECTION,
    };
    controller.setComparison(comparison);
    expect(measured()).toEqual(['structures']);
    expect(controller.parts()[1].section).toBe(SECTION);
    // One of the two is deleted.
    structures.set([ROI_A]);
    expect(measured()).toEqual([]);
    structures.set([ROI_A, ROI_B]);
    expect(measured()).toEqual(['structures']);
    // Another image is on screen.
    volume.set(volumeOf('CT'));
    expect(measured()).toEqual([]);
    controller.setComparison(null);
    volume.set(BASE.volume);
    expect(measured()).toEqual([]);
  });

  it('reports a field’s measures only of the field in use now', () => {
    const { controller, field, measured } = setup();
    const one = { grid: {} } as unknown as PlacementField;
    const report: FieldReport = { field: one, section: SECTION };
    controller.setFieldMeasures(report);
    // Measured of a field that is not the one in use (none is).
    expect(measured()).toEqual([]);
    field.set(one);
    expect(measured()).toEqual(['field']);
    field.set({ grid: {} } as unknown as PlacementField);
    expect(measured()).toEqual([]);
  });

  it('puts together the two images, the registration and the parts, without identifiers unless asked', () => {
    const { controller } = setup();
    const made = new Date(2026, 10, 4);
    const content = controller.content([], made)!;
    expect(content.identifiers).toBe(false);
    expect(content.images.map((image) => [image.role, image.rows.length])).toEqual([
      ['Base image', 2],
      ['Compared image', 2],
    ]);
    expect(content.registration).toBe(
      'Placed by registration “REGISTRATION” (written this image → base).',
    );
    expect(content.steps).toEqual(registrationTables(PLACEMENT, false));
    expect(content.parts).toBe(controller.parts());
    const text = JSON.stringify(content);
    for (const identifier of ['DOE', 'ID-42', '2026-01-05', 'Chest CT', 'Planning', '1.2.3.reg']) {
      expect(text, identifier).not.toContain(identifier);
    }
    // Asked for: each image's own, and the registration's UID.
    controller.toggleIdentifiers();
    const withThem = controller.content([], made)!;
    expect(withThem.identifiers).toBe(true);
    expect(cells(withThem.images[1].rows)).toContainEqual(['Series', 'T2']);
    expect(cells(withThem.images[1].rows)).toContainEqual(['Frame of Reference UID', 'follow-up']);
    expect(JSON.stringify(withThem.steps)).toContain('1.2.3.reg');
  });

  it('saves the report as one HTML file with the pictures of the panes', async () => {
    const { controller, download, pictures } = setup();
    const saving = controller.save();
    expect(controller.busy()).toBe(true);
    // A second request while the first is under way makes no second file.
    await controller.save();
    await saving;
    expect(controller.busy()).toBe(false);
    expect(pictures).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    const [file, name] = download.mock.calls[0];
    expect(name).toBe('registration-report-20261104-090507.html');
    expect(file.type).toBe('text/html');
    const html = await file.text();
    expect(html).toContain('Not for clinical use.');
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="Axial">');
    expect(html).toContain('Made 2026-11-04 09:05.');
  });

  it('saves a report without pictures when none can be taken', async () => {
    const { controller, download, pictures } = setup();
    pictures.mockRejectedValueOnce(new Error('no canvas'));
    await controller.save();
    expect(controller.busy()).toBe(false);
    const html = await download.mock.calls[0][0].text();
    expect(html).toContain('No picture could be taken.');
  });
});
