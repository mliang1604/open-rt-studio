/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computed, inject, Injectable, type Signal } from '@angular/core';
import { Orientation, patientToVoxel, type Vec3, type Volume } from '@open-rt-studio/dicom';
import {
  buildCenterline,
  focusPanePoint,
  probeVoxel,
  resolveGeometry,
  straightenedCpr,
  type CprImage,
  type PaneRect,
} from '@open-rt-studio/render';

import type { PanePlacement } from '../pane-placement';
import type { PerOrientation, PerOrientationOblique, PerOrientationPan } from '../viewer-overlays';
import { CprStore } from './cpr-store';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** The view state the controller reads to map between panes and the patient. */
export interface CprInit {
  readonly volume: () => Volume | null;
  readonly panes: () => readonly PanePlacement[];
  readonly paneKey: (pane: PanePlacement) => string;
  /** Canvas bounding rect, for client to canvas coordinates. */
  readonly canvasBounds: () => DOMRect;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  readonly sliceIndices: Signal<PerOrientation>;
  readonly sagittalFlipped: () => boolean;
}

/** The path as it is drawn over one MPR pane, in canvas CSS pixels. */
export interface CprPanePath {
  readonly key: string;
  readonly rect: PaneRect;
  /** Control points, with their index in the path. */
  readonly handles: readonly { readonly index: number; readonly x: number; readonly y: number }[];
  /** The smooth centreline, as an SVG points string relative to the pane. */
  readonly line: string;
}

/**
 * Glue between the curved reformat tool and the viewer: turns a click on a
 * pane into a point in the patient, draws the path back onto every pane, and
 * computes the reformat from the path. The geometry itself is in
 * `packages/render` (`cpr.ts`, `probe.ts`, `crosshair.ts`).
 */
@Injectable()
export class CprController {
  private readonly store = inject(CprStore);
  private deps: CprInit | null = null;

  init(deps: CprInit): void {
    this.deps = deps;
  }

  /** Sampling step along and across the path: the finest voxel spacing, at least 0.5 mm. */
  private readonly stepMm = computed(() => {
    const volume = this.deps?.volume();
    return volume ? Math.max(0.5, Math.min(...volume.spacing)) : 1;
  });

  /** The straightened reformat along the path, or null without a volume or a path. */
  readonly image = computed<CprImage | null>(() => {
    const volume = this.deps?.volume();
    if (!volume || !this.store.hasPath()) return null;
    try {
      return straightenedCpr(volume, this.store.points(), {
        stepMm: this.stepMm(),
        halfWidthMm: this.store.halfWidthMm(),
        angle: (this.store.angleDeg() * Math.PI) / 180,
      });
    } catch {
      return null; // a degenerate path (all points on one spot) has no reformat
    }
  });

  /** Length of the path along its centreline, in mm. */
  readonly lengthMm = computed(() => {
    const image = this.image();
    return image ? (image.height - 1) * image.mmPerRow : 0;
  });

  /** The path projected onto each MPR pane, for the overlay. */
  readonly panePaths = computed<CprPanePath[]>(() => {
    const d = this.deps;
    const volume = d?.volume();
    const points = this.store.points();
    if (!d || !volume || points.length === 0) return [];
    const line =
      points.length >= 2
        ? buildCenterline(points, { stepMm: this.stepMm() }).samples.map((s) => s.position)
        : [];
    const result: CprPanePath[] = [];
    for (const pane of d.panes()) {
      if (pane.kind !== 'mpr') continue;
      const project = (point: Vec3) => this.toPane(volume, pane, point);
      const handles = points
        .map((point, index) => ({ index, at: project(point) }))
        .filter((h) => h.at !== null)
        .map((h) => ({ index: h.index, x: h.at!.x, y: h.at!.y }));
      const linePoints = line
        .map(project)
        .filter((p) => p !== null)
        .map((p) => `${(p!.x - pane.rect.x).toFixed(1)},${(p!.y - pane.rect.y).toFixed(1)}`);
      result.push({ key: d.paneKey(pane), rect: pane.rect, handles, line: linePoints.join(' ') });
    }
    return result;
  });

  /** A press on a pane while the tool is drawing: add the point under the cursor. */
  placePoint(placement: MprPlacement, event: { clientX: number; clientY: number }): void {
    const point = this.patientAt(placement, event.clientX, event.clientY);
    if (point) this.store.add(point);
  }

  /** A handle is dragged in the pane with the given key: move its point there. */
  movePoint(index: number, paneKey: string, clientX: number, clientY: number): void {
    const d = this.deps;
    const pane = d?.panes().find((p) => p.kind === 'mpr' && d.paneKey(p) === paneKey);
    if (!pane || pane.kind !== 'mpr') return;
    const point = this.patientAt(pane, clientX, clientY);
    if (point) this.store.move(index, point);
  }

  /** The patient position under a client point in a pane; null outside the image. */
  private patientAt(placement: MprPlacement, clientX: number, clientY: number): Vec3 | null {
    const d = this.deps;
    const volume = d?.volume();
    if (!d || !volume) return null;
    const bounds = d.canvasBounds();
    const { orientation } = placement;
    const sample = probeVoxel(
      volume,
      orientation,
      d.sliceIndices()[orientation],
      d.zooms()[orientation],
      placement.rect,
      clientX - bounds.left,
      clientY - bounds.top,
      this.flipped(placement),
      d.pans()[orientation],
      d.obliques()[orientation],
    );
    return sample ? sample.patient : null;
  }

  /** Where a patient position falls in a pane, in canvas CSS pixels. */
  private toPane(volume: Volume, pane: MprPlacement, point: Vec3): { x: number; y: number } | null {
    const d = this.deps!;
    const voxel = patientToVoxel(resolveGeometry(volume), point);
    if (!voxel) return null;
    const { orientation } = pane;
    return focusPanePoint(
      volume,
      orientation,
      voxel,
      d.zooms()[orientation],
      pane.rect,
      this.flipped(pane),
      d.pans()[orientation],
      d.obliques()[orientation],
    );
  }

  private flipped(pane: MprPlacement): boolean {
    return pane.orientation === Orientation.Sagittal && this.deps!.sagittalFlipped();
  }
}
