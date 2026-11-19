/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import {
  Orientation,
  gridPlaneOf,
  patientToVoxel,
  voxelToPatient,
  type PlaneSpan,
  type Series,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  cursorVoxel,
  isOblique,
  probeVoxel,
  mmPerScreenPixel,
  planeExtentMm,
  planeFrame,
  planeToPanePoint,
  resolveGeometry,
  type BrushShape,
  type StampPlane,
  type VoxelIndex,
} from '@open-rt-studio/render';
import { EditableStructuresStore } from './editable-structures-store';
import { sphereSection } from './contour-tools/sphere-section';
import { DATA_SOURCE } from '../data-source/data-source';
import { authoredSetRtStruct } from './structure-set-export';
import { type PanePlacement } from './pane-placement';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** The brush gesture mode: idle, painting the active ROI, or erasing to background. */
export type BrushMode = 'off' | 'paint' | 'erase';

/** Smallest / largest brush radius the size slider offers, in patient millimetres. */
export const MIN_BRUSH_MM = 0.5;
export const MAX_BRUSH_MM = 50;

/** Component view state the {@link BrushController} reads; wired via {@link BrushController.init}. */
export interface BrushInit {
  readonly volume: () => Volume | null;
  readonly isReady: () => boolean;
  /** Canvas bounding rect, for client→pane-local coordinates (matches the probe). */
  readonly canvasBounds: () => DOMRect;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  readonly sliceIndices: Signal<PerOrientation>;
  readonly sagittalFlipped: () => boolean;
  /** The panes on screen, for the sphere brush's cuts through the others (#108). */
  readonly panes: () => readonly PanePlacement[];
  /**
   * The window the image is shown through now, for a tool that sees the
   * image as the user does (#340). Left out, it is the image's own.
   */
  readonly displayWindow?: () => { readonly center: number; readonly width: number };
  /** The image series on screen, which an exported structure set is tied to. */
  readonly baseSeries: () => Series | null;
  /** Say something over the viewport for a while; longer when it is a problem. */
  readonly notify: (message: string, problem: boolean) => void;
}

/**
 * Owns the brush's settings and the painted structures' sets (#268): the
 * paint/erase mode, the structure painted into, the brush's shape and size, and
 * the export. It gives the brush tool the voxel under a pointer (the very inverse
 * the probe runs, so the brush agrees with the displayed slice) and how large a
 * screen pixel is on a pane.
 *
 * The brush settings (radius, footprint, paint/erase mode, active ROI) live here
 * as signals rather than on the component: they're a self-contained tool the
 * structures toolbar binds to, and the controller's lifetime tracks the viewer
 * (provided at the component, like `MeasureController`). The
 * strokes themselves are the brush tool's (`contour-tools/brush-tool.ts`, #106),
 * which the {@link InteractionController} hands a left-drag to through the
 * contouring tool framework while a brush mode is selected.
 */
@Injectable()
export class BrushController {
  private readonly store = inject(EditableStructuresStore);
  private readonly source = inject(DATA_SOURCE);
  private deps: BrushInit | null = null;

  /** Brush radius in patient millimetres; bound to the toolbar size slider. */
  readonly radiusMm = signal(5);
  /** Footprint: a 3D ball (default) or a flat disk confined to the painted slice. */
  readonly shape = signal<BrushShape>('sphere');
  /** Current gesture mode; `'off'` leaves the left-drag as a pan. */
  readonly mode = signal<BrushMode>('off');
  /** The ROI id the brush paints into; null when none is chosen yet. */
  readonly activeRoiId = signal<number | null>(null);

  /** The active set's authored structures, for the toolbar's active-ROI selector. */
  readonly rois = this.store.activeRois;

  /** The authored structure sets, for the toolbar's active-set selector. */
  readonly sets = this.store.sets;

  /** The active authored set's id, for the active-set selector; null when none. */
  readonly activeSetId = this.store.activeSetId;

  /** The active set's label, for the rename field; '' when no set is active yet. */
  readonly activeSetLabel = computed(() => this.store.activeSet()?.label ?? '');

  /** True while a save is on its way to a source that stores; the button waits for it. */
  readonly saving = signal(false);

  /**
   * Whether a brush gesture should claim the next left-drag: a mode is selected,
   * a label volume exists, and — for painting — an ROI is active. Erasing needs no
   * active ROI (it clears whatever is under the brush back to background).
   */
  /** Whether there is anything to export: the active set has at least one structure. */
  readonly canExport = computed(
    () => this.store.labelVolume() !== null && (this.store.activeSet()?.rois.length ?? 0) > 0,
  );

  readonly isActive = computed(() => {
    if (!this.store.labelVolume()) return false;
    const mode = this.mode();
    if (mode === 'paint') return this.activeRoiId() !== null;
    return mode === 'erase';
  });

  /** Wire the controller to the component's view state. Called once. */
  init(deps: BrushInit): void {
    this.deps = deps;
  }

  /** Toggle a paint/erase mode on (selecting it) or off (back to the pan gesture). */
  toggleMode(mode: Exclude<BrushMode, 'off'>): void {
    if (this.mode() === mode) {
      this.mode.set('off');
      return;
    }
    if (mode === 'paint') this.ensureActiveRoi();
    this.mode.set(mode);
  }

  /** Turn the brush off (e.g. when another tool takes over). */
  deactivate(): void {
    this.mode.set('off');
  }

  /**
   * Create a fresh structure in the active set, select it, and switch to
   * painting it; or leave the brush as it is, for another tool that is in
   * hand to work on the new structure (#353).
   */
  newStructure(paint = true): void {
    const roi = this.store.createRoi();
    this.activeRoiId.set(roi.id);
    if (paint) this.mode.set('paint');
  }

  /**
   * Create a fresh, empty authored set and make it the brush's target: new
   * structures and strokes now land here, never in any imported set (#274). Clears
   * the active ROI so the next paint authors into the new set.
   */
  newSet(): void {
    this.store.createSet();
    this.activeRoiId.set(null);
  }

  /**
   * Switch which authored set the brush targets, from the toolbar selector. The
   * active ROI is reset to the new set's first structure (or none) so strokes stay
   * scoped to the active set.
   */
  onSetSelect(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const id = Number(event.target.value);
    if (!Number.isFinite(id)) return;
    this.store.setActiveSet(id);
    const rois = this.store.activeRois();
    this.activeRoiId.set(rois.length > 0 ? rois[0].id : null);
  }

  /**
   * Delete a painted structure. If the brush was painting into it, the brush
   * moves to the first structure left in the active set, or to none, and with
   * none left to paint into it stops painting.
   */
  removeRoi(id: number): void {
    this.store.deleteRoi(id);
    if (this.activeRoiId() === id) this.retarget();
  }

  /** Delete an authored set and its structures; the brush follows to the set now active. */
  removeSet(id: number): void {
    this.store.deleteSet(id);
    this.retarget();
  }

  /** Point the brush at a structure that exists: the one it has, else the active set's first. */
  private retarget(): void {
    const rois = this.store.activeRois();
    if (rois.some((roi) => roi.id === this.activeRoiId())) return;
    this.activeRoiId.set(rois.length > 0 ? rois[0].id : null);
    if (rois.length === 0 && this.mode() === 'paint') this.deactivate();
  }

  /** Paint into this structure from now on, making its set the active one. */
  selectRoi(id: number): void {
    const set = this.store.sets().find((s) => s.rois.some((roi) => roi.id === id));
    if (!set) return;
    this.store.setActiveSet(set.id);
    this.activeRoiId.set(id);
  }

  /** Rename the active authored set from the toolbar field. */
  onSetRename(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const id = this.store.activeSetId();
    if (id !== null) this.store.renameSet(id, event.target.value);
  }

  /** Select which structure the brush paints into, from the toolbar selector. */
  onRoiSelect(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const id = Number(event.target.value);
    this.activeRoiId.set(Number.isFinite(id) && id > 0 ? id : null);
  }

  /** Set the brush radius (mm) from the toolbar slider. */
  onRadiusInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const mm = Number(event.target.value);
    if (Number.isFinite(mm)) this.radiusMm.set(mm);
  }

  /** Switch the footprint between the sphere and the flat disk. */
  onShapeChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    this.shape.set(event.target.value === 'disk' ? 'disk' : 'sphere');
  }

  /**
   * Save the active authored set as a DICOM RT Structure Set. The painted
   * voxels become contours, and the object refers to the series on screen so it
   * can be put back on the same images, here or in another system.
   *
   * Where it goes is the data source's to say: a download for opened files, an
   * upload for a server. Each save is a new object, as the set is at that
   * moment; saving twice leaves two, and neither replaces the other.
   */
  async exportActiveSet(): Promise<void> {
    const label = this.store.labelVolume();
    const set = this.store.activeSet();
    if (!label || !set || set.rois.length === 0 || this.saving()) return;
    const { bytes, filename } = authoredSetRtStruct(
      label,
      set,
      this.deps?.baseSeries() ?? null,
      new Date(),
    );
    const name = set.label.trim() || 'Authored structures';
    this.saving.set(true);
    try {
      const outcome = await this.source.save({ bytes, filename, mediaType: 'application/dicom' });
      // A download shows itself in the browser. An upload shows nowhere, so say it.
      if (outcome.kind === 'stored') {
        this.deps?.notify(
          `Saved “${name}” (${outcome.where}). It comes with this series the next time it is loaded.`,
          false,
        );
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.deps?.notify(`“${name}” was not saved. ${why}`, true);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * How many millimetres of the pane's plane a screen pixel is, at its zoom:
   * what the brush's outline is drawn by, as the scale bar is. 0 without an image.
   */
  mmPerPixel(placement: Extract<PanePlacement, { kind: 'mpr' }>): number {
    const volume = this.deps?.volume();
    if (!volume) return 0;
    const [planeW, planeH] = planeExtentMm(volume, placement.orientation);
    return mmPerScreenPixel(
      planeW,
      planeH,
      placement.rect.width,
      placement.rect.height,
      this.deps!.zooms()[placement.orientation],
    );
  }

  /**
   * Where a ball about a voxel cuts the other MPR panes of the column the
   * pointer is in (#108): on each whose plane it reaches, the foot of its
   * centre in pixels from that pane's corner, how far the centre is from
   * the plane in mm, and how large a pixel is there.
   */
  sphereSections(
    over: Extract<PanePlacement, { kind: 'mpr' }>,
    voxel: VoxelIndex,
    radiusMm: number,
  ): {
    readonly rect: Extract<PanePlacement, { kind: 'mpr' }>['rect'];
    readonly x: number;
    readonly y: number;
    readonly distanceMm: number;
    readonly mmPerPixel: number;
  }[] {
    const d = this.deps;
    const volume = d?.volume();
    if (!d || !volume) return [];
    const centre = voxelToPatient(resolveGeometry(volume), voxel);
    const sections = [];
    for (const pane of d.panes()) {
      if (
        pane.kind !== 'mpr' ||
        pane.group !== over.group ||
        pane.orientation === over.orientation
      ) {
        continue;
      }
      const o = pane.orientation;
      const frame = planeFrame(volume, o, d.sliceIndices()[o], d.obliques()[o]);
      const section = sphereSection(centre, radiusMm, frame);
      const mmPerPixel = this.mmPerPixel(pane);
      if (!section || !(mmPerPixel > 0)) continue;
      const at = planeToPanePoint(
        volume,
        o,
        section.u,
        section.v,
        d.zooms()[o],
        pane.rect,
        o === Orientation.Sagittal && d.sagittalFlipped(),
        d.pans()[o],
      );
      sections.push({
        rect: pane.rect,
        x: at.x - pane.rect.x,
        y: at.y - pane.rect.y,
        distanceMm: section.distanceMm,
        mmPerPixel,
      });
    }
    return sections;
  }

  /** The MPR panes of a column of the layout (#293): where a tool that works through the volume shows itself. */
  mprPanes(group: number): Extract<PanePlacement, { kind: 'mpr' }>[] {
    return (this.deps?.panes() ?? []).filter(
      (pane): pane is Extract<PanePlacement, { kind: 'mpr' }> =>
        pane.kind === 'mpr' && pane.group === group,
    );
  }

  /** The slice of the grid a pane shows, across the axis it steps through; null for a tilted pane. */
  sliceOf(placement: Extract<PanePlacement, { kind: 'mpr' }>): number | null {
    const d = this.deps;
    if (!d || isOblique(d.obliques()[placement.orientation])) return null;
    return d.sliceIndices()[placement.orientation];
  }

  /** Where a pointer event is within its pane, in pixels from the pane's corner. */
  paneLocal(pointer: {
    readonly placement: Extract<PanePlacement, { kind: 'mpr' }>;
    readonly event: PointerEvent;
  }): { readonly x: number; readonly y: number } | null {
    if (!this.deps) return null;
    const bounds = this.deps.canvasBounds();
    return {
      x: pointer.event.clientX - bounds.left - pointer.placement.rect.x,
      y: pointer.event.clientY - bounds.top - pointer.placement.rect.y,
    };
  }

  /** The voxel under a pointer event on an MPR pane, via the shared probe inverse. */
  voxelAt(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    event: PointerEvent,
  ): VoxelIndex | null {
    const bounds = this.deps?.canvasBounds();
    if (!bounds) return null;
    return this.voxelAtCanvas(placement, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  /** The voxel at a point of the canvas (pixels from its corner) over an MPR pane. */
  voxelAtCanvas(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    x: number,
    y: number,
  ): VoxelIndex | null {
    const d = this.deps;
    if (!d) return null;
    const volume = d.volume();
    if (!volume) return null;
    const orientation = placement.orientation;
    return cursorVoxel(
      volume,
      orientation,
      d.sliceIndices()[orientation],
      d.zooms()[orientation],
      placement.rect,
      x,
      y,
      orientation === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[orientation],
      d.obliques()[orientation],
    );
  }

  /**
   * The plane a tilted MPR pane shows (#303): as a span of the grid, in
   * voxels, from the plane frame the shader and the probe go by; and as a
   * normal and offset in mm of the grid, for a brush stamp. Null for a pane
   * that is not tilted, or before an image.
   */
  tiltedPlaneOf(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
  ): { readonly span: PlaneSpan; readonly stamp: StampPlane } | null {
    const d = this.deps;
    const volume = d?.volume();
    const o = placement.orientation;
    if (!d || !volume || !isOblique(d.obliques()[o])) return null;
    const frame = planeFrame(volume, o, d.sliceIndices()[o], d.obliques()[o]);
    const geometry = resolveGeometry(volume);
    const origin = patientToVoxel(geometry, frame.origin);
    const toward = (along: Vec3): Vec3 | null => {
      const end = patientToVoxel(geometry, [
        frame.origin[0] + along[0],
        frame.origin[1] + along[1],
        frame.origin[2] + along[2],
      ]);
      return origin && end ? [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]] : null;
    };
    const [alongU, alongV] = [toward(frame.alongU), toward(frame.alongV)];
    if (!origin || !alongU || !alongV) return null;
    // In mm of the grid: the plane's normal, and how far along it the plane lies.
    const span: PlaneSpan = { origin, alongU, alongV };
    const stamp = gridPlaneOf(span, volume.spacing);
    return stamp ? { span, stamp } : null;
  }

  /**
   * The continuous voxel of the grid at a point of the canvas over an MPR
   * pane (#114): where in the volume the point is, not rounded to a voxel.
   */
  continuousVoxelAtCanvas(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    x: number,
    y: number,
  ): Vec3 | null {
    const d = this.deps;
    const volume = d?.volume();
    if (!d || !volume) return null;
    const o = placement.orientation;
    const probe = probeVoxel(
      volume,
      o,
      d.sliceIndices()[o],
      d.zooms()[o],
      placement.rect,
      x,
      y,
      o === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[o],
      d.obliques()[o],
    );
    return probe ? patientToVoxel(resolveGeometry(volume), probe.patient) : null;
  }

  /**
   * Where a continuous voxel is in a pane, in pixels from the pane's corner,
   * and how far it is from the pane's plane in mm (#114): what is drawn of
   * points kept in the volume, wherever the pane has been zoomed or panned to.
   */
  paneLocalOfVoxel(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    voxel: Vec3,
  ): { readonly x: number; readonly y: number; readonly offPlaneMm: number } | null {
    const d = this.deps;
    const volume = d?.volume();
    if (!d || !volume) return null;
    const o = placement.orientation;
    const frame = planeFrame(volume, o, d.sliceIndices()[o], d.obliques()[o]);
    const section = sphereSection(voxelToPatient(resolveGeometry(volume), voxel), Infinity, frame);
    if (!section) return null;
    const at = planeToPanePoint(
      volume,
      o,
      section.u,
      section.v,
      d.zooms()[o],
      placement.rect,
      o === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[o],
    );
    return {
      x: at.x - placement.rect.x,
      y: at.y - placement.rect.y,
      offPlaneMm: section.distanceMm,
    };
  }

  /** The spacing of the grid's voxels, in mm along each axis; [1, 1, 1] before an image. */
  voxelSpacing(): readonly [number, number, number] {
    return this.deps?.volume()?.spacing ?? [1, 1, 1];
  }

  /**
   * The values the image is shown between now, darkest to brightest: the
   * window on screen. Null before an image is loaded.
   */
  displayWindow(): { readonly low: number; readonly high: number } | null {
    const volume = this.deps?.volume();
    if (!volume) return null;
    const shown = this.deps?.displayWindow?.() ?? {
      center: volume.windowCenter,
      width: volume.windowWidth,
    };
    return { low: shown.center - shown.width / 2, high: shown.center + shown.width / 2 };
  }

  /**
   * The modality of the image the structures are drawn on; null before one
   * is loaded. What remembers a tool's settings goes by it (#346).
   */
  imageModality(): string | null {
    return this.deps?.volume()?.modality ?? null;
  }

  /** Ensure an ROI is selected to paint into, picking the first or creating one. */
  ensureActiveRoi(): void {
    if (this.activeRoiId() !== null) return;
    const rois = this.rois();
    this.activeRoiId.set(rois.length > 0 ? rois[0].id : this.store.createRoi().id);
  }
}
