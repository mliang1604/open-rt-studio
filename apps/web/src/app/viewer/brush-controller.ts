/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { Orientation, type Series, type Volume } from '@open-rt-studio/dicom';
import {
  cursorVoxel,
  strokeVoxels,
  throughPlaneAxis,
  type BrushShape,
  type VoxelIndex,
} from '@open-rt-studio/render';
import { EditableStructuresStore } from './editable-structures-store';
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
  /** The image series on screen, which an exported structure set is tied to. */
  readonly baseSeries: () => Series | null;
  /** Say something over the viewport for a while; longer when it is a problem. */
  readonly notify: (message: string, problem: boolean) => void;
}

/**
 * Owns the brush / eraser editing gesture (#268): it turns a pointer stroke over
 * an MPR pane into label-volume voxels and writes them through the
 * {@link EditableStructuresStore}. The geometry stays pure and tested in
 * `src/render/brush.ts` — this controller is the wiring that feeds it the probed
 * cursor voxel (reusing the very inverse the probe runs, so the brush agrees with
 * the displayed slice) and the active brush settings.
 *
 * The brush settings (radius, footprint, paint/erase mode, active ROI) live here
 * as signals rather than on the component: they're a self-contained tool the
 * structures toolbar binds to, and the controller's lifetime tracks the viewer
 * (provided at the component, like `MeasureController`). The
 * {@link InteractionController} routes left-drag here when {@link isActive} is
 * true, so painting takes over from pan only while a brush mode is selected.
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

  /** The voxel the last stroke sample landed on, so a drag can interpolate from it. */
  private lastVoxel: VoxelIndex | null = null;

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
    this.lastVoxel = null;
  }

  /** Create a fresh structure in the active set, select it, and switch to painting it. */
  newStructure(): void {
    const roi = this.store.createRoi();
    this.activeRoiId.set(roi.id);
    this.mode.set('paint');
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
   * Begin a stroke at the press point: stamp the brush on the voxel under the
   * cursor and remember it as the stroke's anchor for the drag to interpolate from.
   */
  beginStroke(placement: Extract<PanePlacement, { kind: 'mpr' }>, event: PointerEvent): void {
    const voxel = this.voxelAt(placement, event);
    this.lastVoxel = voxel;
    if (voxel) this.paintStroke(placement.orientation, voxel, voxel);
  }

  /**
   * Extend the stroke to the cursor's current voxel, painting every stamp between
   * it and the previous sample so a fast drag leaves no gaps.
   */
  extendStroke(placement: Extract<PanePlacement, { kind: 'mpr' }>, event: PointerEvent): void {
    const voxel = this.voxelAt(placement, event);
    if (!voxel) return;
    const from = this.lastVoxel ?? voxel;
    this.paintStroke(placement.orientation, from, voxel);
    this.lastVoxel = voxel;
  }

  /** End the current stroke. */
  endStroke(): void {
    this.lastVoxel = null;
  }

  /** Paint (or erase) every voxel the stroke from `from` to `to` covers. */
  private paintStroke(orientation: Orientation, from: VoxelIndex, to: VoxelIndex): void {
    const label = this.store.labelVolume();
    if (!label) return;
    const mode = this.mode();
    const voxels = strokeVoxels(label.dims, label.spacing, from, to, {
      shape: this.shape(),
      radiusMm: this.radiusMm(),
      axis: throughPlaneAxis(orientation),
    });
    if (voxels.length === 0) return;
    if (mode === 'paint') {
      const roiId = this.activeRoiId();
      if (roiId !== null) this.store.paint(roiId, voxels);
    } else if (mode === 'erase') {
      this.store.erase(voxels);
    }
  }

  /** The voxel under a pointer event on an MPR pane, via the shared probe inverse. */
  private voxelAt(
    placement: Extract<PanePlacement, { kind: 'mpr' }>,
    event: PointerEvent,
  ): VoxelIndex | null {
    const d = this.deps;
    if (!d) return null;
    const volume = d.volume();
    if (!volume) return null;
    const orientation = placement.orientation;
    const bounds = d.canvasBounds();
    return cursorVoxel(
      volume,
      orientation,
      d.sliceIndices()[orientation],
      d.zooms()[orientation],
      placement.rect,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      orientation === Orientation.Sagittal && d.sagittalFlipped(),
      d.pans()[orientation],
      d.obliques()[orientation],
    );
  }

  /** Ensure an ROI is selected to paint into, picking the first or creating one. */
  private ensureActiveRoi(): void {
    if (this.activeRoiId() !== null) return;
    const rois = this.rois();
    this.activeRoiId.set(rois.length > 0 ? rois[0].id : this.store.createRoi().id);
  }
}
