/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, type Signal } from '@angular/core';
import {
  Orientation,
  pointBetweenLayers,
  valueUnit,
  type Layer,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  DEFAULT_COLORMAP,
  isodoseLines,
  isodoseSampleCounts,
  planeFrame,
  planeToPanePoint,
  samplePlane,
  volumeInterpolator,
  type ObliqueRotation,
  type PaneRect,
  type PlaneSamples,
} from '@open-rt-studio/render';

import { DATA_SOURCE } from '../../data-source/data-source';
import { LayersController } from '../layers-controller';
import { paneKeyOf, type PanePlacement } from '../pane-placement';
import type { PerOrientationOblique } from '../viewer-overlays';
import { DoseDisplayStore } from './dose-display-store';
import {
  doseLegend,
  referenceDose,
  washRange,
  washWindow,
  type DoseDisplay,
  type DoseLegendRow,
} from './dose-levels';

/** A prescription of a plan of the images on screen, to take 100 % from. */
export interface PrescriptionChoice {
  readonly gy: number;
  readonly to: string | null;
  /** In words: `60 Gy to “PTV” (Plan A)`. */
  readonly label: string;
}

/** One level's lines in a pane. */
export interface IsodosePath {
  /** The level as a dose, to two decimals: what the line is at. */
  readonly dose: string;
  readonly colour: string;
  /** The lines as an SVG path, in the pane's own pixels. */
  readonly d: string;
}

/** The isodose lines of one pane. */
export interface IsodosePane {
  readonly paneKey: string;
  readonly rect: PaneRect;
  readonly paths: readonly IsodosePath[];
}

/** What the controller reads of the viewer; wired once through {@link DoseController.init}. */
export interface DoseInit {
  readonly isReady: () => boolean;
  readonly panes: () => readonly PanePlacement[];
  readonly obliques: Signal<PerOrientationOblique>;
  readonly sagittalFlipped: () => boolean;
}

/** A number for each object, to tell one placement from another in a key. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identityOf(object: object | null | undefined): number {
  if (!object) return 0;
  let id = identities.get(object);
  if (id === undefined) identities.set(object, (id = nextIdentity++));
  return id;
}

/**
 * How the dose on screen is shown (#94): which layer it is, its legend, and
 * its isodose lines pane by pane. The state is in {@link DoseDisplayStore};
 * the colour wash is the layer's own, and its range is the layer's window.
 */
@Injectable()
export class DoseController {
  private readonly layersCtl = inject(LayersController);
  private readonly store = inject(DoseDisplayStore);
  private readonly source = inject(DATA_SOURCE);
  private deps: DoseInit | null = null;

  init(deps: DoseInit): void {
    this.deps = deps;
  }

  /**
   * The dose that is shown: of the doses laid over the image, the first
   * that is drawn, or the first when none is; or the image itself when it
   * is one. Null when there is no dose on screen. With several doses over
   * an image (#102) it is the one the user has left showing.
   */
  readonly layer = computed<Layer | null>(() => {
    const layers = this.layersCtl.layers();
    const over = layers.filter((layer) => layer.role === 'overlay' && !!layer.volume.dose);
    return (
      over.find((layer) => layer.visible) ??
      over[0] ??
      layers.find((layer) => !!layer.volume.dose) ??
      null
    );
  });

  readonly display = computed<DoseDisplay | null>(() => {
    const layer = this.layer();
    return layer ? this.store.displayFor(layer.id) : null;
  });

  /** The dose's largest value, in its own unit. */
  readonly max = computed(() => this.layer()?.volume.max ?? 0);

  /** The dose's unit: `Gy`, or nothing for a relative dose. */
  readonly unit = computed(() => {
    const layer = this.layer();
    return (layer && valueUnit(layer.volume)) || '';
  });

  /** The doses at the two ends of the colour wash. */
  readonly range = computed<[number, number]>(() => {
    const layer = this.layer();
    return layer ? washRange(this.layersCtl.layerWindow(layer)) : [0, 1];
  });

  /** The colour map the lines take their colours from: the wash's, or the usual one for a grey dose. */
  private readonly map = computed(() => {
    const display = this.layer()?.display;
    return display?.kind === 'colormap' ? display.name : DEFAULT_COLORMAP;
  });

  /** A row to each level: what the lines are at, and in what colour. */
  readonly legend = computed<DoseLegendRow[]>(() => {
    const display = this.display();
    if (!display) return [];
    return doseLegend(display, this.max(), this.unit(), this.range(), this.map());
  });

  /** Whether percent has something to be percent of. */
  readonly hasReference = computed(() => {
    const display = this.display();
    return !!display && referenceDose(display.reference, this.max()) !== null;
  });

  /**
   * The prescriptions to targets of the plans of the images on screen, for
   * the user to take 100 % from. None is taken for them.
   */
  readonly prescriptions = computed<PrescriptionChoice[]>(() => {
    const loaded = new Set(this.layersCtl.layers().map((layer) => layer.id));
    if (loaded.size === 0 || this.unit() !== 'Gy') return [];
    const seen = new Set<string>();
    const choices: PrescriptionChoice[] = [];
    for (const study of this.source.currentPatient()?.studies ?? []) {
      for (const series of study.series) {
        if (!loaded.has(series.uid)) continue;
        for (const object of series.attached ?? []) {
          if (!object.plan || seen.has(object.sopInstanceUid)) continue;
          seen.add(object.sopInstanceUid);
          const plan = object.plan.label ?? object.description?.trim() ?? 'plan';
          for (const one of object.plan.prescriptions) {
            if (one.type === 'ORGAN_AT_RISK' || !(one.gy > 0)) continue;
            const to = one.to ? ` to “${one.to}”` : '';
            choices.push({
              gy: one.gy,
              to: one.to,
              label: `${Number(one.gy.toFixed(2))} Gy${to} (${plan})`,
            });
          }
        }
      }
    }
    return choices;
  });

  /** Set the colour wash to run from `low` to `high`. Ends that are no range change nothing. */
  setRange(low: number, high: number): void {
    const layer = this.layer();
    if (!layer || !(Number.isFinite(low) && Number.isFinite(high) && high > low)) return;
    this.layersCtl.setLayerWindow(layer, washWindow(low, high));
  }

  /** The dose sampled over each pane's plane, kept until the plane or the dose is another. */
  private readonly sampled = new Map<
    string,
    { readonly key: string; readonly samples: PlaneSamples }
  >();

  /**
   * The isodose lines, pane by pane (#94). In each pane the dose is read
   * where the pane's image is, through the registrations that place the two,
   * as the probe reads it; the lines are where it is at each level.
   */
  readonly panes = computed<IsodosePane[]>(() => {
    const d = this.deps;
    const layer = this.layer();
    const display = this.display();
    if (!d || !d.isReady() || !layer || !display?.lines || !layer.visible) return [];
    const rows = this.legend().filter((row) => row.dose !== null);
    if (rows.length === 0) return [];
    const layers = this.layersCtl.layers();
    const read = volumeInterpolator(layer.volume);
    const voxel = Math.min(...layer.volume.spacing);
    const out: IsodosePane[] = [];
    const live = new Set<string>();
    for (const pane of d.panes()) {
      if (pane.kind !== 'mpr') continue;
      const { group, orientation, rect } = pane;
      const grid = this.layersCtl.groupVolume(group);
      if (!grid || rect.width < 1 || rect.height < 1) continue;
      const shown = layers.find((one) => one.volume === grid);
      const paneKey = paneKeyOf(pane);
      live.add(paneKey);
      const sliceIndex = this.layersCtl.paneSliceIndex(group, orientation);
      const oblique = d.obliques()[orientation];
      const samples = this.samplesOf(paneKey, {
        layer,
        grid,
        shown,
        orientation,
        sliceIndex,
        oblique,
        read,
        voxel,
      });
      const zoom = this.layersCtl.paneZoom(group, orientation);
      const pan = this.layersCtl.panePan(group, orientation);
      const flipX = orientation === Orientation.Sagittal && d.sagittalFlipped();
      const paths: IsodosePath[] = [];
      for (const row of rows) {
        let path = '';
        for (const line of isodoseLines(samples, row.dose!)) {
          line.points.forEach(([u, v], at) => {
            const point = planeToPanePoint(grid, orientation, u, v, zoom, rect, flipX, pan);
            path += `${at === 0 ? 'M' : 'L'}${(point.x - rect.x).toFixed(1)} ${(point.y - rect.y).toFixed(1)}`;
          });
          if (line.closed) path += 'Z';
        }
        if (path) paths.push({ dose: row.dose!.toFixed(2), colour: row.colour, d: path });
      }
      if (paths.length > 0) out.push({ paneKey, rect, paths });
    }
    for (const key of this.sampled.keys()) if (!live.has(key)) this.sampled.delete(key);
    return out;
  });

  private samplesOf(
    paneKey: string,
    of: {
      layer: Layer;
      grid: Volume;
      shown: Layer | undefined;
      orientation: Orientation;
      sliceIndex: number;
      oblique: ObliqueRotation;
      read: (patient: readonly [number, number, number]) => number | null;
      voxel: number;
    },
  ): PlaneSamples {
    const { layer, grid, shown, orientation, sliceIndex, oblique } = of;
    const key = [
      identityOf(layer.volume),
      identityOf(grid),
      identityOf(layer.placement),
      identityOf(shown?.placement),
      orientation,
      sliceIndex,
      oblique.tiltU,
      oblique.tiltV,
      ...(oblique.pivot ?? []),
    ].join('|');
    const kept = this.sampled.get(paneKey);
    if (kept?.key === key) return kept.samples;
    const frame = planeFrame(grid, orientation, sliceIndex, oblique);
    const [across, down] = isodoseSampleCounts(frame, of.voxel);
    const samples = samplePlane(
      frame,
      (point) => {
        // Where a deformation field says nothing the dose is not drawn, and not read.
        const at = pointBetweenLayers(point, shown?.placement, layer.placement);
        return at ? of.read(at) : null;
      },
      across,
      down,
    );
    this.sampled.set(paneKey, { key, samples });
    return samples;
  }
}
