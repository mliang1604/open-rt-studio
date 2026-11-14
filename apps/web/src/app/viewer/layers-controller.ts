/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  LayoutMode,
  blendBarPlacement,
  type BlendBar,
  type Vec2,
  linkedSliceIndex,
  sliceCountFor,
  windowPresets,
  fittingGridSpacingMm,
  type FieldView,
  type FieldViewKind,
  type WindowLevel,
  type WindowPreset,
  COLORMAPS,
} from '@open-rt-studio/render';
import {
  baseLayer,
  DEFAULT_OVERLAY_OPACITY,
  findPlacement,
  invertMat4,
  jacobianDeterminants,
  Orientation,
  pointToLayer,
  sampleDeformation,
  sampleGridValues,
  transformPoint,
  transformVector,
  type Layer,
  type LayerDisplay,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  LayersStore,
  fittingFieldScaleMm,
  isDeformable,
  layerLegend,
  placementNames,
  type LayerLegendEntry,
} from './layers-store';
import type { FieldWayBack } from './field-metrics/field-metrics-panel';
import { canShareWindow, CompareStore, type GroupNav } from './compare-store';
import { type LoadState } from './load-controller';
import { type PanePlacement } from './pane-placement';
import type { FieldReading } from './viewer-format';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

/** Component view state the {@link LayersController} reads; wired via {@link LayersController.init}. */
export interface LayersInit {
  readonly load: () => LoadState;
  readonly layoutMode: WritableSignal<LayoutMode>;
  readonly panes: () => readonly PanePlacement[];
  readonly sliceIndices: Signal<PerOrientation>;
  readonly zooms: Signal<PerOrientation>;
  readonly pans: Signal<PerOrientationPan>;
  readonly obliques: Signal<PerOrientationOblique>;
  /** The hovered Compare column index (drives which layer windowing targets). */
  readonly activeCompareGroup: () => number;
  /** Hold the 3D MIP at reduced quality until interaction settles. */
  readonly markMipSettling: () => void;
}

function intValue(event: Event): number {
  if (!(event.target instanceof HTMLInputElement)) return 0;
  const parsed = Number(event.target.value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/**
 * Owns the layer registry / fusion / Compare domain: the loaded {@link Layer}
 * stack and its base {@link volume}, the active fusion overlay, the shared and
 * per-overlay window/level, the layers-panel + blend-bar + checkerboard controls,
 * and the Compare linked/unlinked per-group slice/zoom/pan resolution. The view
 * tuples it resolves against stay on the component (read through {@link init});
 * this owns the layer + window/level state and the {@link LayersStore} /
 * {@link CompareStore} plumbing. Provided at the component so its lifetime tracks
 * the viewer.
 */
@Injectable()
export class LayersController {
  private readonly layerStore = inject(LayersStore);
  private readonly compareStore = inject(CompareStore);
  private deps: LayersInit | null = null;

  /** Shared base-layer window centre (the overlay reads its own per-layer override). */
  readonly windowCenter = signal(0);
  /** Shared base-layer window width. */
  readonly windowWidth = signal(1);

  /** Compare-layout linking state (aliases the store). */
  readonly compareLinked = this.compareStore.linked;
  /** Per-group independent slice/zoom/pan when unlinked (aliases the store). */
  readonly groupNav = this.compareStore.groupNav;
  /** Checkerboard the overlay instead of a uniform blend (aliases the store). */
  readonly checkerboardEnabled = this.layerStore.checkerboardEnabled;
  /** Checkerboard density in cells across the image (aliases the store). */
  readonly checkerCells = this.layerStore.checkerCells;
  /** Overlay display choices for the layers panel: grayscale plus each colormap. */
  readonly displayOptions = ['grayscale', ...Object.keys(COLORMAPS)];

  /** Wire the controller to the component's load + view state. Called once. */
  init(deps: LayersInit): void {
    this.deps = deps;
  }

  /** The loaded layer registry, or empty until a load succeeds. */
  readonly layers = computed<readonly Layer[]>(() => {
    const state = this.deps!.load();
    if (state.status !== 'ready') return [];
    return this.layerStore.apply(state.result.layers);
  });

  /** The base layer's volume — what reslice, probe, contours, crosshair and capture read. */
  readonly volume = computed<Volume | null>(() => baseLayer(this.layers())?.volume ?? null);

  /** The active fusion overlay: the first visible `'overlay'`-role layer, or null. */
  readonly selectedOverlay = computed<Layer | null>(
    () => this.layers().find((layer) => layer.role === 'overlay' && layer.visible) ?? null,
  );

  /**
   * Whether the Compare layout shows the active overlay in the base's planes:
   * so for one that a registration places. Such an image's own grid is not
   * where the base's is, so its column is drawn as the base's column is, plane
   * for plane, with the overlay read through the registration. Everything
   * about where that column is (its slices, its zoom, what a click points at)
   * is then the base's, and only the picture and its window are the overlay's.
   */
  readonly compareInBasePlanes = computed(() => !!this.selectedOverlay()?.placement);

  /** True in the side-by-side Compare layout (vs. the composited fusion views). */
  readonly isCompare = computed(() => this.deps!.layoutMode() === LayoutMode.Compare);

  /** True in the composited Fusion view (the 3-pane MPR with the overlay blended in). */
  readonly isFusion = computed(() => this.deps!.layoutMode() === LayoutMode.TriMpr);

  /** The layer the window/level controls target (the hovered Compare column's, else base). */
  readonly activeWlLayer = computed<Layer | null>(() => {
    const base = baseLayer(this.layers()) ?? null;
    if (!this.isCompare()) return base;
    const overlay = this.selectedOverlay();
    if (!overlay) return base;
    return this.deps!.activeCompareGroup() >= 1 ? overlay : base;
  });

  /** Whether the Compare columns are asked to show one window (aliases the store). */
  readonly compareWindowLinked = this.compareStore.windowLinked;

  /** The modalities of the two Compare columns: the base layer and the overlay. */
  readonly compareModalities = computed<readonly [string | null, string | null]>(() => [
    baseLayer(this.layers())?.volume.modality ?? null,
    this.selectedOverlay()?.volume.modality ?? null,
  ]);

  /** Whether the two columns hold the same modality, so one window can serve both. */
  readonly canShareWindow = computed(() => canShareWindow(...this.compareModalities()));

  /** Whether the overlay is showing the base layer's window: linked, and possible. */
  readonly windowShared = computed(() => this.compareStore.sharesWindow(this.canShareWindow()));

  /** Whether a layer shows, and edits, the base window: the base, or the overlay while shared. */
  private usesBaseWindow(layer: Layer | null): boolean {
    if (!layer || layer.role === 'base') return true;
    return this.windowShared() && layer.id === this.selectedOverlay()?.id;
  }

  /**
   * Resolve a layer's window/level: base reads the shared signals, an overlay
   * its override, or the base's window while the Compare window is linked.
   */
  layerWindow(layer: Layer | null): WindowLevel {
    if (!layer || this.usesBaseWindow(layer)) {
      return { center: this.windowCenter(), width: this.windowWidth() };
    }
    return this.layerStore.windowFor(layer);
  }

  /**
   * Write a layer's window/level: base updates the shared signals, an overlay
   * its override. While the Compare window is linked a change made on either
   * column goes to the one window both show.
   */
  setLayerWindow(layer: Layer | null, next: WindowLevel): void {
    if (!layer || this.usesBaseWindow(layer)) {
      this.windowCenter.set(next.center);
      this.windowWidth.set(next.width);
    } else {
      this.layerStore.setWindow(layer.id, next);
    }
  }

  /**
   * Show both Compare columns with one window/level (the left column's), or
   * give each its own again. Unlinking leaves the right column on the window it
   * was showing.
   */
  toggleCompareWindowLinked(): void {
    this.compareStore.toggleWindowLinked(this.canShareWindow(), () => {
      const overlay = this.selectedOverlay();
      if (overlay) this.layerStore.setWindow(overlay.id, this.layerWindow(null));
    });
    this.deps!.markMipSettling();
  }

  /** The active target's window centre, shown in the WL input. */
  readonly activeWindowCenter = computed(() => this.layerWindow(this.activeWlLayer()).center);
  /** The active target's window width, shown in the WW input. */
  readonly activeWindowWidth = computed(() => this.layerWindow(this.activeWlLayer()).width);

  /** Whether the layers panel applies: more than the lone base layer is loaded. */
  readonly hasLayersPanel = computed(() => this.layers().length > 1);

  /** The layers for the panel, each with its display controls (base first). */
  readonly layerLegend = computed<LayerLegendEntry[]>(() =>
    layerLegend(this.layers(), this.layerStore.byHand()),
  );

  /** Toggle an overlay layer's visibility (the base underlay is never hidden). */
  toggleLayerVisible(id: string): void {
    this.layerStore.toggleVisible(id);
  }

  /** Layers-panel opacity slider for a layer. */
  onLayerOpacity(id: string, event: Event): void {
    this.layerStore.setOpacity(id, Number((event.target as HTMLInputElement).value));
  }

  /** Layers-panel registration selector: which of a layer's registrations places it. */
  onLayerPlacement(id: string, event: Event): void {
    this.layerStore.choosePlacement(id, Number((event.target as HTMLSelectElement).value));
  }

  /** Layers-panel switch: apply a layer's deformation field, or leave it out. */
  toggleDeformation(id: string): void {
    this.layerStore.toggleDeformation(id);
  }

  /** Layers-panel display selector: grayscale or a named colormap for the layer. */
  onLayerDisplay(id: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const display: LayerDisplay =
      value === 'grayscale' ? { kind: 'grayscale' } : { kind: 'colormap', name: value };
    this.layerStore.setDisplay(id, display);
  }

  /** View-mode selector: Fusion (composited 3-pane) vs Compare (side-by-side 6-pane). */
  setViewMode(mode: 'fusion' | 'compare'): void {
    this.deps!.layoutMode.set(mode === 'compare' ? LayoutMode.Compare : LayoutMode.TriMpr);
  }

  /**
   * The volume whose grid a Compare group is laid out on: the base for group
   * 0, the active overlay otherwise, unless that overlay is shown in the
   * base's planes ({@link compareInBasePlanes}).
   */
  groupVolume(group: number): Volume | null {
    if (group === 0 || this.compareInBasePlanes()) return this.volume();
    return this.selectedOverlay()?.volume ?? this.volume();
  }

  /**
   * The layer whose image a pane of a group shows: the base, or in the second
   * Compare column the active overlay (the base when there is none).
   */
  groupLayer(group: number): Layer | null {
    const base = baseLayer(this.layers()) ?? null;
    if (group === 0 || !this.isCompare()) return base;
    return this.selectedOverlay() ?? base;
  }

  /** Whether a Compare group navigates on its own (unlinked, and not the base group). */
  groupIsIndependent(group: number): boolean {
    return this.compareStore.isIndependent(group, this.isCompare());
  }

  /** The slice index a pane shows, resolving linked/unlinked Compare navigation. */
  paneSliceIndex(group: number, orientation: Orientation): number {
    const d = this.deps!;
    const master = d.sliceIndices()[orientation];
    return this.compareStore.resolveSlice(group, orientation, this.isCompare(), master, () => {
      const base = this.volume();
      const target = this.groupVolume(group);
      if (!base || !target) return master;
      return linkedSliceIndex(base, target, orientation, master, d.obliques()[orientation]);
    });
  }

  /**
   * The slice a pane shows, as its tag has it: "7 / 12", of the column the
   * pane is in. A Compare column that navigates by itself, or is laid out on
   * another grid than the base's, has a slice and a count of its own (#230).
   */
  paneSliceLabel(group: number, orientation: Orientation): string {
    const volume = this.groupVolume(group);
    const count = volume ? sliceCountFor(volume, orientation) : 0;
    return count > 0 ? `${this.paneSliceIndex(group, orientation) + 1} / ${count}` : '–';
  }

  /** The zoom a pane uses: shared while linked, the group's own when unlinked. */
  paneZoom(group: number, orientation: Orientation): number {
    return this.compareStore.resolveZoom(
      group,
      orientation,
      this.isCompare(),
      this.deps!.zooms()[orientation],
    );
  }

  /** The pan a pane uses: shared while linked, the group's own when unlinked. */
  panePan(group: number, orientation: Orientation): Vec2 {
    return this.compareStore.resolvePan(
      group,
      orientation,
      this.isCompare(),
      this.deps!.pans()[orientation],
    );
  }

  /** Link or unlink the Compare groups (unlinking snapshots the current per-group view). */
  toggleCompareLinked(): void {
    this.compareStore.toggleLinked(() => this.snapshotGroupNav());
  }

  /** Snapshot the current per-group view (while still linked) for unlinked editing. */
  snapshotGroupNav(): GroupNav[] {
    const d = this.deps!;
    return this.compareStore.snapshot(d.zooms(), d.pans(), (group, orientation) =>
      this.paneSliceIndex(group, orientation),
    );
  }

  /** Replace one field of one group's independent nav (used by the unlinked handlers). */
  updateGroupNav(group: number, patch: Partial<GroupNav>): void {
    this.compareStore.updateGroupNav(group, patch);
  }

  /** The deformation field of the registration that places the active overlay, or null. */
  readonly selectedField = computed(() => this.selectedOverlay()?.placement?.field ?? null);
  /** The displacement wash's scale that fits that field, in mm; worked out once for a field. */
  private readonly fittingScaleMm = computed(() => {
    const field = this.selectedField();
    return field ? fittingFieldScaleMm(field.grid) : 1;
  });
  /**
   * What of the field is washed over the image (#83), as the renderer takes
   * it: the kind and opacity the user chose, on the scale they set or the
   * one that fits the field in use.
   */
  readonly fieldView = computed<FieldView>(() => ({
    kind: this.layerStore.fieldViewKind(),
    opacity: this.layerStore.fieldViewOpacity(),
    maxMm: this.layerStore.fieldViewMaxMm() ?? this.fittingScaleMm(),
  }));
  /** Whether the displacement wash's scale is the one that fits the field, not one the user set. */
  readonly fieldViewScaleFits = computed(() => this.layerStore.fieldViewMaxMm() === null);
  /** The field's Jacobian determinant at each vector of its grid: worked out once for a field, when first read. */
  private readonly fieldJacobian = computed(() => {
    const field = this.selectedField();
    return field ? jacobianDeterminants(field.grid, field.pre, field.post) : null;
  });
  /**
   * The determinants the determinant wash is drawn from, or null while it is
   * not shown: the renderer's wash and the readout under the cursor are of
   * these same numbers.
   */
  readonly fieldViewDeterminants = computed(() =>
    this.layerStore.fieldViewKind() === 'jacobian' ? this.fieldJacobian() : null,
  );

  /**
   * The way back from the compared image's frame to the base's, for inverse
   * consistency (#84): another registration than the one that places the
   * image through its field. One when exactly one leads back; with several,
   * none is picked for the user; null when none does, or there is no field.
   */
  readonly fieldWayBack = computed<FieldWayBack | null>(() => {
    const placement = this.selectedOverlay()?.placement;
    const state = this.deps!.load();
    if (!placement?.field || state.status !== 'ready') return null;
    const there = new Set(placement.steps.map((step) => step.sopInstanceUid));
    const others = state.result.registrations.filter((one) => !there.has(one.sopInstanceUid));
    const found = findPlacement(placement.layerFrame, placement.baseFrame, others);
    if (found.kind === 'several') return { kind: 'several', count: found.placements.length };
    if (found.kind !== 'placed') return null;
    const back = found.placement;
    return {
      kind: 'one',
      name: placementNames(back),
      deformable: isDeformable(back),
      map: (point) => pointToLayer(back, point),
    };
  });

  /** The grid spacing that fits the overlay: about an eighth of its longest side. */
  private readonly fittingGridMm = computed(() => {
    const volume = this.selectedOverlay()?.volume;
    return volume
      ? fittingGridSpacingMm(volume.dims.map((count, axis) => count * volume.spacing[axis]))
      : 1;
  });
  /** Whether the deformed grid is drawn (aliases the store). */
  readonly fieldGridOn = this.layerStore.fieldGrid;
  /** The distance between the deformed grid's lines, in mm: the user's, or the one that fits. */
  readonly fieldGridSpacingMm = computed(
    () => this.layerStore.fieldGridSpacingMm() ?? this.fittingGridMm(),
  );
  readonly fieldGridSpacingFits = computed(() => this.layerStore.fieldGridSpacingMm() === null);
  /** The spacing as the renderer takes it: null while no grid is drawn. */
  readonly fieldGridDrawn = computed(() =>
    this.layerStore.fieldGrid() ? this.fieldGridSpacingMm() : null,
  );
  /** Whether the field is drawn as arrows (aliases the store). */
  readonly fieldArrowsOn = this.layerStore.fieldArrows;

  toggleFieldGrid(): void {
    this.layerStore.toggleFieldGrid();
  }

  setFieldGridSpacingMm(mm: number | null): void {
    this.layerStore.setFieldGridSpacingMm(mm);
  }

  toggleFieldArrows(): void {
    this.layerStore.toggleFieldArrows();
  }

  /** The field's matrix before it, turned round: from the field's grid back to the base's frame. */
  private readonly fieldToBase = computed(() => {
    const field = this.selectedField();
    return field ? invertMat4(field.pre) : null;
  });

  /**
   * The field's displacement at a point of the base image's frame, as a
   * vector of that frame in mm: what is added to the point before the
   * registration's matrices alone would take it to where the compared image
   * is read for it. Null with no field, and where it has no vector to go by.
   */
  fieldDisplacementAt(basePoint: Vec3): Vec3 | null {
    const field = this.selectedField();
    const toBase = this.fieldToBase();
    if (!field || !toBase) return null;
    const moved = sampleDeformation(field.grid, transformPoint(field.pre, basePoint));
    return moved ? transformVector(toBase, moved) : null;
  }

  /**
   * What the wash on screen stands for at a point of the base image's frame:
   * how far the field moves it, or the field's Jacobian determinant there,
   * read between the grid's vectors as the shader reads it. Null with no wash
   * on, with no field, and where the field has no vector to go by, which is
   * where no wash is drawn.
   */
  fieldReading(basePoint: Vec3): FieldReading | null {
    const field = this.selectedField();
    const kind = this.layerStore.fieldViewKind();
    if (!field || kind === 'none') return null;
    const at = transformPoint(field.pre, basePoint);
    const moved = sampleDeformation(field.grid, at);
    if (!moved) return null;
    if (kind === 'displacement') {
      return { kind, mm: Math.hypot(moved[0], moved[1], moved[2]) };
    }
    const determinants = this.fieldJacobian();
    const determinant = determinants ? sampleGridValues(field.grid, determinants, at) : null;
    return determinant === null ? null : { kind, determinant };
  }

  setFieldViewKind(kind: FieldViewKind): void {
    this.layerStore.setFieldViewKind(kind);
  }

  setFieldViewOpacity(opacity: number): void {
    this.layerStore.setFieldViewOpacity(opacity);
  }

  /** Set the top of the displacement wash's scale in mm; null for the one that fits the field. */
  setFieldViewMaxMm(maxMm: number | null): void {
    this.layerStore.setFieldViewMaxMm(maxMm);
  }

  /** Whether the fusion controls apply: an overlay is active AND we're compositing. */
  readonly hasOverlay = computed(() => this.selectedOverlay() !== null && !this.isCompare());

  /** Toggle compositing the fusion overlay as a checkerboard. */
  toggleCheckerboard(): void {
    this.layerStore.toggleCheckerboard();
  }

  /** Set the checkerboard density (cells across the image) from the slider, clamped. */
  onCheckerCellsInput(event: Event): void {
    this.layerStore.setCheckerCells(Number((event.target as HTMLInputElement).value));
  }

  /** The active overlay's composite opacity as a 0..100 percentage. */
  readonly blendPercent = computed(() =>
    Math.round((this.selectedOverlay()?.opacity ?? DEFAULT_OVERLAY_OPACITY) * 100),
  );

  /** Placement of the in-pane blend bar over the largest MPR pane, or null. */
  readonly blendBar = computed<BlendBar | null>(() => {
    if (!this.hasOverlay()) return null;
    const mprRects = this.deps!.panes()
      .filter((pane) => pane.kind === 'mpr')
      .map((pane) => pane.rect);
    return blendBarPlacement(mprRects);
  });

  /** Drag/keyboard the blend bar: set the active overlay's opacity from its 0..100 value. */
  onBlendInput(event: Event): void {
    const overlay = this.selectedOverlay();
    if (overlay) {
      this.layerStore.setOpacity(overlay.id, Number((event.target as HTMLInputElement).value));
    }
  }

  /** Window/level presets offered for the active target (base, or the hovered overlay). */
  readonly wlPresets = computed<WindowPreset[]>(() => {
    const volume = this.activeWlLayer()?.volume ?? this.volume();
    return volume ? windowPresets(volume) : [];
  });

  /** Set the active target's window centre from the WL input. */
  onWindowCenterInput(event: Event): void {
    const layer = this.activeWlLayer();
    this.setLayerWindow(layer, { center: intValue(event), width: this.layerWindow(layer).width });
    this.deps!.markMipSettling();
  }

  /** Set the active target's window width from the WW input. */
  onWindowWidthInput(event: Event): void {
    const layer = this.activeWlLayer();
    this.setLayerWindow(layer, {
      center: this.layerWindow(layer).center,
      width: Math.max(1, intValue(event)),
    });
    this.deps!.markMipSettling();
  }

  /** Apply the chosen window/level preset to the active target, then reset the selector. */
  onPresetChange(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const preset = this.wlPresets()[Number(event.target.value)];
    event.target.selectedIndex = 0; // back to the "Preset…" placeholder so re-picking fires
    if (!preset) return;
    this.setLayerWindow(this.activeWlLayer(), { center: preset.center, width: preset.width });
    this.deps!.markMipSettling();
  }

  /** Reset the layers panel to defaults for a fresh base load. */
  reset(): void {
    this.layerStore.reset();
  }
}
