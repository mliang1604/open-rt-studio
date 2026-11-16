/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  sliceMask,
  type LabelChange,
  type LabelConstraints,
  type LabelVolume,
  type PlaneSpan,
} from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { PreferencesStore } from '../../preferences-store';
import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { PanePlacement } from '../pane-placement';
import {
  CONTOUR_TOOLS,
  type ContourTool,
  type ContourToolContext,
  type ToolPointer,
  type ToolPreviewCircle,
} from './contour-tool';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** A slice of the label grid: across `axis`, at `slice`. */
export interface DrawnSlice {
  readonly kind: 'slice';
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
}

/** A tilted plane a tool drew on (#303), as a span of the grid in voxels. */
export interface DrawnPlane {
  readonly kind: 'plane';
  readonly span: PlaneSpan;
}

/** Where a structure was drawn: a slice of the grid, or a tilted plane. */
export type Drawn = DrawnSlice | DrawnPlane;

/**
 * Runs the contouring tools (#106): which is in hand, its stroke as one edit
 * of the painted structures, the constraints every tool's changes go
 * through, undo and redo, and whether tools of the labs are offered. See
 * `contour-tool.ts`.
 */
@Injectable()
export class ContourToolsController {
  private readonly tools = inject(CONTOUR_TOOLS);
  private readonly store = inject(EditableStructuresStore);
  private readonly brush = inject(BrushController);
  private readonly preferences = inject(PreferencesStore);

  /** Whether tools that are not finished are offered. */
  readonly labs = computed(() => this.preferences.preferences().labsTools);

  /** The tool taken up from the list of tools; the brush is in hand by its own mode. */
  private readonly taken = signal<string | null>(null);

  /** The tools listed for the taking: the brush stands apart, and tools of the labs only with the flag on. */
  readonly listed = computed(() =>
    this.tools.filter((tool) => tool.listed && (!tool.labs || this.labs())),
  );

  /** The tool in hand; null for none. */
  readonly held = computed<ContourTool | null>(() => {
    if (this.brush.mode() !== 'off') return this.tool('brush');
    const id = this.taken();
    return id === null ? null : this.tool(id);
  });

  /** Whether a press on a pane is the held tool's: there is something to edit, and the tool can be used. */
  readonly isActive = computed(() => {
    const tool = this.held();
    return this.store.labelVolume() !== null && tool !== null && tool.ready();
  });

  /** What the held tool draws over the panes; null for nothing. */
  readonly preview = computed<ToolPreviewCircle | null>(() =>
    this.isActive() ? (this.held()?.preview?.() ?? null) : null,
  );

  /** Leave voxels of other structures than the one edited as they are. */
  readonly protectOthers = signal(false);
  /** Change only voxels of this structure; null for anywhere. */
  readonly clipToRoiId = signal<number | null>(null);
  /** Change only voxels whose image value is within a range, when on. */
  readonly intensityOn = signal(false);
  readonly intensityMin = signal<number | null>(null);
  readonly intensityMax = signal<number | null>(null);

  /** The constraints as they apply now: a clip structure that is gone clips nothing. */
  readonly constraints = computed<LabelConstraints>(() => {
    const clip = this.clipToRoiId();
    const [min, max] = [this.intensityMin(), this.intensityMax()];
    return {
      protectOthers: this.protectOthers(),
      clipToRoiId: clip !== null && this.store.rois().some((roi) => roi.id === clip) ? clip : null,
      intensity:
        this.intensityOn() && min !== null && max !== null
          ? { min: Math.min(min, max), max: Math.max(min, max) }
          : null,
    };
  });

  /** Whether any constraint is on, for whoever says so. */
  readonly constrained = computed(() => {
    const c = this.constraints();
    return c.protectOthers || c.clipToRoiId !== null || c.intensity !== null;
  });

  readonly nextUndo = this.store.nextUndo;
  readonly nextRedo = this.store.nextRedo;

  /** The tool whose stroke is under way. */
  private stroking: ContourTool | null = null;

  /**
   * Where strokes painted (#302), for each structure, by a key; kept for
   * the label grid they were drawn on, and forgotten when another is
   * loaded. A tool draws across the grid axis of its pane's orientation, at
   * the voxel under the pointer: on a tilted pane, a stroke paints grid
   * slices, and may cross several; unless it draws on the pane's own plane
   * (#303), which is kept.
   */
  private drawn: {
    readonly label: LabelVolume | null;
    readonly slices: Map<number, Map<string, Drawn>>;
  } = { label: null, slices: new Map() };

  /** Where a structure was drawn with the tools (#302, #303); nothing for another grid. */
  drawnSlices(roiId: number): Drawn[] {
    const label = this.store.labelVolume();
    if (!label || this.drawn.label !== label) return [];
    return [...(this.drawn.slices.get(roiId)?.values() ?? [])];
  }

  /** Keep where a stroke paints under the pointer, for the structure being edited. */
  private recordSlice(tool: ContourTool, pointer: ToolPointer): void {
    const label = this.store.labelVolume();
    const roiId = this.brush.activeRoiId();
    const voxel = this.brush.voxelAt(pointer.placement, pointer.event);
    if (!label || roiId === null || !voxel) return;
    if (this.drawn.label !== label) this.drawn = { label, slices: new Map() };
    const slices = this.drawn.slices.get(roiId) ?? new Map<string, Drawn>();
    const span = tool.drawsOnPlane?.(pointer.placement) ?? null;
    if (span) {
      const key = [...span.origin, ...span.alongU, ...span.alongV]
        .map((v) => v.toFixed(3))
        .join(',');
      slices.set(`plane:${key}`, { kind: 'plane', span });
    } else {
      const axis = throughPlaneAxis(pointer.placement.orientation);
      slices.set(`${axis}:${voxel[axis]}`, { kind: 'slice', axis, slice: voxel[axis] });
    }
    this.drawn.slices.set(roiId, slices);
  }

  /** What a tool sees and does. */
  private readonly context: ContourToolContext = {
    voxelAt: (pointer) => this.brush.voxelAt(pointer.placement, pointer.event),
    grid: () => {
      const label = this.store.labelVolume();
      return label ? { dims: label.dims, spacing: label.spacing } : null;
    },
    activeRoiId: () => this.brush.activeRoiId(),
    held: (voxel) => {
      const label = this.store.labelVolume();
      if (!label) return 0;
      const [nx, ny] = label.dims;
      return label.data[(voxel[2] * ny + voxel[1]) * nx + voxel[0]] ?? 0;
    },
    image: () => this.store.imageData(),
    sliceMask: (roiId, axis, slice) => {
      const label = this.store.labelVolume();
      return label ? sliceMask(label, roiId, axis, slice) : null;
    },
    voxelAtCanvas: (placement, x, y) => this.brush.voxelAtCanvas(placement, x, y),
    change: (change) => this.store.applyChange(change, this.constraints()),
  };

  /** Turn the labs flag on or off. A tool of the labs in hand is put down when it goes off. */
  setLabs(on: boolean): void {
    this.preferences.update({ labsTools: on });
    if (!on && this.held()?.labs) this.putDown();
  }

  /** Take up a listed tool, or put it down when it is in hand. */
  toggle(id: string): void {
    if (this.taken() === id) {
      this.putDown();
      return;
    }
    this.cancel();
    const tool = this.listed().find((one) => one.id === id) ?? null;
    this.taken.set(tool?.id ?? null);
    tool?.activate?.();
  }

  /** The listed tool in hand, by id; null for none (the brush is not listed). */
  readonly takenId = this.taken.asReadonly();

  /** Put down a listed tool, cancelling a stroke under way. */
  putDown(): void {
    this.cancel();
    this.taken.set(null);
  }

  /** The pointer went down on a pane: the held tool begins an edit. */
  begin(placement: MprPlacement, event: PointerEvent): void {
    const tool = this.held();
    if (!tool || !this.isActive()) return;
    this.cancel();
    this.store.beginEdit(tool.editName());
    this.stroking = tool;
    tool.begin(this.context, { placement, event });
    this.recordSlice(tool, { placement, event });
    // What the edit is, the tool may know only now: a push in or out (#117).
    this.store.renameEdit(tool.editName());
  }

  /** The pointer moved with its button down. */
  extend(placement: MprPlacement, event: PointerEvent): void {
    if (!this.stroking) return;
    this.stroking.extend(this.context, { placement, event });
    this.recordSlice(this.stroking, { placement, event });
  }

  /** The pointer came up: the edit is committed, and can be undone. */
  end(): void {
    const tool = this.stroking;
    if (!tool) return;
    tool.end(this.context);
    this.stroking = null;
    this.store.commitEdit();
    this.announce(tool.editName());
  }

  /**
   * The edits made through the tools, one more each time one is made: its
   * name and a count. A tool that keeps up with the others (interpolation,
   * #115) follows it. Undo and redo are not edits made.
   */
  readonly edited = signal<{ readonly name: string; readonly count: number }>({
    name: '',
    count: 0,
  });

  private announce(name: string): void {
    this.edited.update((last) => ({ name, count: last.count + 1 }));
  }

  /** Put back what the stroke under way changed. Returns whether there was one. */
  cancel(): boolean {
    const tool = this.stroking;
    if (!tool) return false;
    tool.cancel();
    this.stroking = null;
    this.store.cancelEdit();
    return true;
  }

  /** The pointer moved over a pane with no button down, or left (null). */
  hover(placement: MprPlacement | null, event: PointerEvent): void {
    const pointer: ToolPointer | null = placement ? { placement, event } : null;
    for (const tool of this.tools) {
      if (tool === this.held() || !pointer) tool.hover?.(this.context, pointer);
    }
  }

  /**
   * Make changes at once, as one edit called `name` that can be undone,
   * through the constraints: for a tool that is a click and not a stroke
   * (a cleanup, #110). Nothing is done while a stroke is under way.
   * Returns how many voxels changed.
   */
  apply(name: string, changes: readonly LabelChange[]): number {
    if (this.stroking) return 0;
    this.store.beginEdit(name);
    let changed = 0;
    for (const change of changes) changed += this.store.applyChange(change, this.constraints());
    this.store.commitEdit();
    if (changed > 0) this.announce(name);
    return changed;
  }

  /** Undo the latest edit; not while a stroke is under way. Returns what was undone. */
  undo(): string | null {
    return this.stroking ? null : this.store.undo();
  }

  /** Redo the latest edit that was undone. Returns what was redone. */
  redo(): string | null {
    return this.stroking ? null : this.store.redo();
  }

  private tool(id: string): ContourTool | null {
    return this.tools.find((tool) => tool.id === id) ?? null;
  }
}
