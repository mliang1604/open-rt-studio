/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  baseLayer,
  type Layer,
  type LayerPlacement,
  type Mat4,
  type PlacementStep,
  type Roi,
  seriesInstanceUidOf,
  type Volume,
} from '@open-rt-studio/dicom';

import { DATA_SOURCE, type PatientHistory } from '../../data-source/data-source';

import type { FieldReport } from '../field-metrics/field-metrics-panel';
import { LandmarkController } from '../landmarks/landmark-controller';
import { landmarkSection } from '../landmarks/landmark-panel';
import { LayersController } from '../layers-controller';
import { placementText, registrationName } from '../layers-store';
import type { ComparisonReport } from '../structure-compare/structure-compare';
import {
  reportFilename,
  reportHtml,
  type ReportContent,
  type ReportImage,
  type ReportPart,
  type ReportPicture,
  type ReportRow,
  type ReportTable,
} from './registration-report';

export interface ReportInit {
  /** The structures of the base image that may be compared now. */
  readonly structures: () => readonly Roi[];
  /** Pictures of the panes as they are drawn now; none when none can be taken. */
  readonly pictures: () => Promise<readonly ReportPicture[]>;
  readonly now: () => Date;
  /** Hand a file to the browser as a download. */
  readonly download: (blob: Blob, filename: string) => void;
}

/** A kind of measurement the report has a place for, and whether it has been made. */
export interface ReportPartState {
  readonly key: string;
  readonly title: string;
  readonly measured: boolean;
}

const size = (volume: Volume): string =>
  `${volume.dims.join(' × ')} voxels of ${volume.spacing.map((mm) => mm.toFixed(2)).join(' × ')} mm`;

/** A DICOM date (YYYYMMDD) with dashes; anything else as it is. */
const date = (value: string): string =>
  /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;

/** What identifies an image: whose it is, and which study and series. */
export interface ImageIdentity {
  readonly patientName: string | null;
  readonly patientId: string | null;
  readonly studyDate: string | null;
  readonly studyDescription: string | null;
  readonly seriesDescription: string | null;
  readonly seriesUid: string;
}

/**
 * What the source knows of the series a layer was built from. A layer's id
 * is its series' UID, with a number after it when the series is on screen
 * twice. Null when the patient on screen has no such series.
 */
export function identityOf(patient: PatientHistory | null, layerId: string): ImageIdentity | null {
  const seriesUid = layerId.replace(/#\d+$/, '');
  for (const study of patient?.studies ?? []) {
    const series = study.series.find((one) => one.uid === seriesUid);
    if (!series) continue;
    return {
      patientName: patient!.name,
      patientId: patient!.patientId,
      studyDate: study.date,
      studyDescription: study.description,
      seriesDescription: series.description,
      // Of one dose of a series of several, the series' own UID and not the key it goes by here.
      seriesUid: seriesInstanceUidOf(seriesUid),
    };
  }
  return null;
}

/**
 * One of the two images as rows. Without identifiers only what the image is
 * made of is said: its kind and its size.
 */
export function imageRows(
  layer: Layer,
  identity: ImageIdentity | null,
  frame: string,
  identifiers: boolean,
): ReportRow[] {
  const rows: ReportRow[] = [
    { name: 'Modality', value: layer.modality ?? 'not known' },
    { name: 'Size', value: size(layer.volume) },
  ];
  if (!identifiers) return rows;
  const said = (name: string, value: string | null | undefined): void => {
    if (value?.trim()) rows.push({ name, value: value.trim() });
  };
  said('Patient’s name', identity?.patientName);
  said('Patient ID', identity?.patientId);
  said('Study date', identity?.studyDate ? date(identity.studyDate) : null);
  said('Study', identity?.studyDescription);
  said('Series', identity?.seriesDescription);
  said('Series Instance UID', identity?.seriesUid);
  said('Frame of Reference UID', frame);
  return rows;
}

/** A frame of reference by the image that is in it, which says more than its UID. */
function frameName(frame: string, placement: LayerPlacement): string {
  if (frame === placement.baseFrame) return 'the base image’s frame';
  if (frame === placement.layerFrame) return 'the compared image’s frame';
  return 'another frame of reference';
}

function stepKind(step: PlacementStep): string {
  if (step.byHand) return 'Made by hand in the viewer';
  return step.deformable
    ? 'Deformation field (DICOM Deformable Spatial Registration)'
    : 'Matrix (DICOM Spatial Registration)';
}

/** A matrix's rows as text, to four places: enough to tell two apart. */
function matrixRows(matrix: Mat4): ReportRow[] {
  return [0, 1, 2, 3].map((row) => ({
    name: `Row ${row + 1}`,
    value: [0, 1, 2, 3].map((column) => matrix[row * 4 + column].toFixed(4)).join('   '),
  }));
}

/**
 * The registrations a placement goes through, each as a table: what it is,
 * which way it was written and which way it is used. Then the matrix the
 * placement comes to, or the field's grid.
 */
export function registrationTables(placement: LayerPlacement, identifiers: boolean): ReportTable[] {
  const { steps, field } = placement;
  const tables: ReportTable[] = steps.map((step, index) => {
    const caption =
      steps.length > 1 ? `Registration ${index + 1} of ${steps.length}` : 'Registration';
    // One made by hand was written nowhere: there is no file to name, and no
    // way round it was written to tell from the way it is used.
    if (step.byHand) {
      return {
        caption,
        rows: [
          { name: 'Name', value: 'none: not from a file' },
          { name: 'Kind', value: stepKind(step) },
        ],
      };
    }
    const rows: ReportRow[] = [
      { name: 'Name', value: registrationName(step) },
      { name: 'Kind', value: stepKind(step) },
      {
        name: 'Written',
        value: `from ${frameName(step.writtenFrom, placement)} to ${frameName(step.writtenTo, placement)}`,
      },
      { name: 'Used', value: step.inverted ? 'turned round' : 'as written' },
    ];
    if (identifiers) rows.push({ name: 'SOP Instance UID', value: step.sopInstanceUid });
    return { caption, rows };
  });
  if (field) {
    const { dims, spacing } = field.grid;
    tables.push({
      caption: 'Deformation field',
      rows: [
        { name: 'Grid', value: `${dims.join(' × ')} vectors` },
        { name: 'Between vectors', value: `${spacing.map((mm) => mm.toFixed(2)).join(' × ')} mm` },
        { name: 'Maps', value: 'from the base image’s frame to the compared image’s' },
      ],
    });
  } else {
    tables.push({
      caption: 'Base image’s frame to the compared image’s, as a matrix (mm)',
      rows: matrixRows(placement.baseToLayer),
    });
  }
  return tables;
}

/**
 * The registration report (#87): what there is to put in it now, and saving
 * it. The numbers come from the panels that measure them: the landmarks from
 * their controller, a comparison of structures and a field's measures as the
 * panels hand them over. What was measured of another image, other
 * structures or another field than those on screen is not reported.
 */
@Injectable()
export class ReportController {
  private readonly layersCtl = inject(LayersController);
  private readonly landmarks = inject(LandmarkController);
  private readonly source = inject(DATA_SOURCE);
  private deps: ReportInit | null = null;

  init(deps: ReportInit): void {
    this.deps = deps;
  }

  /** Whether the patient's and the objects' identifiers go into the report. Not unless asked. */
  readonly identifiers = signal(false);
  /** Whether a report is being put together. */
  readonly busy = signal(false);
  private readonly comparison = signal<ComparisonReport | null>(null);
  private readonly fieldMeasures = signal<FieldReport | null>(null);

  /** The compared image and the registration that places it, when there is one. */
  private readonly placed = computed(() => {
    const layer = this.layersCtl.selectedOverlay();
    return layer?.placement ? { layer, placement: layer.placement } : null;
  });

  /** A report is of a registration: there is one when it places the compared image. */
  readonly available = computed(() => this.placed() !== null);

  setComparison(report: ComparisonReport | null): void {
    this.comparison.set(report);
  }

  setFieldMeasures(report: FieldReport | null): void {
    this.fieldMeasures.set(report);
  }

  toggleIdentifiers(): void {
    this.identifiers.update((on) => !on);
  }

  /** The three kinds of measurement, each with its section when it has been made. */
  readonly parts = computed<ReportPart[]>(() => {
    const comparison = this.comparison();
    const structures = this.deps?.structures() ?? [];
    const comparisonNow =
      comparison &&
      comparison.volume === this.layersCtl.volume() &&
      comparison.rois.every((roi) => structures.includes(roi))
        ? comparison.section
        : null;
    const field = this.fieldMeasures();
    const fieldNow = field && field.field === this.layersCtl.selectedField() ? field.section : null;
    return [
      {
        key: 'landmarks',
        title: 'Landmarks: target registration error',
        section: landmarkSection(
          this.landmarks.rows(),
          this.landmarks.error(),
          this.landmarks.registration(),
          this.landmarks.measuredIn(),
        ),
      },
      {
        key: 'structures',
        title: 'Structures: surface distances and overlap',
        section: comparisonNow,
      },
      { key: 'field', title: 'Deformation field', section: fieldNow },
    ];
  });

  /** The same, as the panel lists them. */
  readonly partStates = computed<ReportPartState[]>(() =>
    this.parts().map(({ key, title, section }) => ({ key, title, measured: section !== null })),
  );

  /** What the report holds now, with these pictures; null when there is no registration. */
  content(pictures: readonly ReportPicture[], made: Date): ReportContent | null {
    const placed = this.placed();
    const base = baseLayer(this.layersCtl.layers());
    if (!placed || !base || !this.deps) return null;
    const identifiers = this.identifiers();
    const patient = this.source.currentPatient();
    const image = (role: string, layer: Layer, frame: string): ReportImage => ({
      role,
      rows: imageRows(layer, identityOf(patient, layer.id), frame, identifiers),
    });
    const { baseFrame, layerFrame } = placed.placement;
    return {
      made,
      identifiers,
      images: [
        image('Base image', base, baseFrame),
        image('Compared image', placed.layer, layerFrame),
      ],
      registration: `${placementText(placed.placement)}.`,
      steps: registrationTables(placed.placement, identifiers),
      parts: this.parts(),
      pictures,
    };
  }

  /** Put the report together and hand it to the browser as a download. */
  async save(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.busy() || !this.available()) return;
    this.busy.set(true);
    try {
      // A report without pictures beats no report.
      const pictures = await deps.pictures().catch(() => []);
      const content = this.content(pictures, deps.now());
      if (!content) return;
      const file = new Blob([reportHtml(content)], { type: 'text/html' });
      deps.download(file, reportFilename(content.made));
    } finally {
      this.busy.set(false);
    }
  }
}
