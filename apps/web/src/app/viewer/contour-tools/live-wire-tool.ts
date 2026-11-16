/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Live wire (#118): click anchors on a pane, and the path from the last
// anchor to the cursor keeps to the image's edges as the cursor moves; each
// click fixes the path so far; clicking the first anchor closes it and fills
// what it encloses, on that slice, into the structure the brush paints into.
// The search is `live-wire.ts`'s: the paths from an anchor to every pixel of
// the slice are found when the anchor is set, and the one to the cursor is
// only traced back as it moves. Of the labs until it proves itself.
//
// The anchors belong to the slice they were set on, across the axis the
// pane steps through; an anchor set on another pane or slice starts over.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  edgeCost,
  fillSliceLoop,
  shortestPaths,
  slicePlane,
  tracePath,
  type PathTree,
  type PlanePoint,
  type Vec3,
} from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import type { PanePlacement } from '../pane-placement';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';
import { POINT_GRAB_PX } from './point-tool';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** Where the anchors are: the pane, and the slice across the axis it steps through. */
interface On {
  readonly placement: MprPlacement;
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
  /** The slice's cost, found once. */
  readonly cost: Float32Array;
  readonly width: number;
  readonly height: number;
}

@Injectable()
export class LiveWireTool implements ContourTool {
  private readonly brush = inject(BrushController);

  readonly id = 'wire';
  readonly name = 'Live wire';
  readonly description =
    'Click anchors: the path between them keeps to the image’s edges; click the first to fill it (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = LiveWireOptions;

  /** The anchors set, in pixels of the slice. */
  readonly anchors = signal<readonly PlanePoint[]>([]);
  /** The path fixed so far, from the first anchor to the last, in pixels of the slice. */
  private readonly fixed = signal<readonly PlanePoint[]>([]);
  /** The path from the last anchor to the cursor. */
  private readonly live = signal<readonly PlanePoint[]>([]);
  private readonly on = signal<On | null>(null);
  private tree: PathTree | null = null;
  /** What came of the last closed path. */
  readonly said = signal<string | null>(null);

  /** The path fixed and the path to the cursor, and the anchors, where they are in the pane now. */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    const on = this.on();
    const anchors = this.anchors();
    if (!on || anchors.length === 0) return null;
    const toPane = this.toPane(on);
    if (!toPane) return null;
    const points = [...this.fixed(), ...this.live()].map(toPane);
    const d = points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join('');
    const handles = anchors.map(toPane).map(([x, y], i) => ({ x, y, first: i === 0 }));
    return {
      rect: on.placement.rect,
      x: handles[0].x,
      y: handles[0].y,
      radiusPx: 0,
      curve: d,
      handles,
    };
  });

  editName(): string {
    return 'Live wire';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
    this.startOver();
  }

  startOver(): void {
    this.anchors.set([]);
    this.fixed.set([]);
    this.live.set([]);
    this.on.set(null);
    this.tree = null;
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    const at = this.pixelAt(context, pointer);
    if (!at) return;
    const { on, pixel, local } = at;
    const anchors = this.anchors();
    // Clicking the first anchor again closes the path.
    const first = this.preview()?.handles?.[0];
    if (
      anchors.length >= 2 &&
      first &&
      Math.hypot(first.x - local.x, first.y - local.y) <= POINT_GRAB_PX
    ) {
      this.close(context, on);
      return;
    }
    // The path so far, to this anchor.
    if (anchors.length > 0 && this.tree) {
      const segment = tracePath(this.tree, pixel);
      this.fixed.update((path) => [...path, ...(path.length > 0 ? segment.slice(1) : segment)]);
    }
    this.anchors.update((list) => [...list, pixel]);
    this.live.set([]);
    this.tree = shortestPaths(on.cost, on.width, on.height, pixel);
  }

  extend(): void {
    // A click, not a stroke.
  }

  end(): void {
    // A click, not a stroke.
  }

  cancel(): void {
    // A click, not a stroke.
  }

  hover(context: ContourToolContext, pointer: ToolPointer | null): void {
    if (!pointer || !this.tree || this.anchors().length === 0) return;
    const on = this.on();
    if (!on || pointer.placement.orientation !== on.placement.orientation) return;
    const at = this.pixelAt(context, pointer, false);
    if (at) this.live.set(tracePath(this.tree, at.pixel));
  }

  /** The pixel of the slice under the pointer; with `settle`, the anchors' slice is set to it, starting over if it is another. */
  private pixelAt(
    context: ContourToolContext,
    pointer: ToolPointer,
    settle = true,
  ): { on: On; pixel: [number, number]; local: { x: number; y: number } } | null {
    const { placement } = pointer;
    const local = this.brush.paneLocal(pointer);
    const image = context.image();
    const grid = context.grid();
    if (!local || !image || !grid) return null;
    const voxel = this.brush.continuousVoxelAtCanvas(
      placement,
      placement.rect.x + local.x,
      placement.rect.y + local.y,
    );
    if (!voxel) return null;
    const axis = throughPlaneAxis(placement.orientation);
    const slice = Math.round(voxel[axis]);
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    const pixel: [number, number] = [Math.round(voxel[a]), Math.round(voxel[b])];
    let on = this.on();
    if (!on || on.axis !== axis || on.slice !== slice || on.placement.group !== placement.group) {
      if (!settle) return null;
      this.startOver();
      const plane = slicePlane(image, grid.dims as [number, number, number], axis, slice);
      on = {
        placement,
        axis,
        slice,
        cost: edgeCost(plane),
        width: plane.width,
        height: plane.height,
      };
      this.on.set(on);
    }
    const inside = pixel[0] >= 0 && pixel[1] >= 0 && pixel[0] < on.width && pixel[1] < on.height;
    return inside ? { on, pixel, local } : null;
  }

  /** Close the path back to the first anchor, fill it on its slice, and start over. */
  private close(context: ContourToolContext, on: On): void {
    const roiId = context.activeRoiId();
    const grid = context.grid();
    const first = this.anchors()[0];
    if (roiId === null || !grid || !this.tree) return;
    const back = tracePath(this.tree, first);
    const loop = [...this.fixed(), ...back.slice(1)];
    const voxels = fillSliceLoop(grid.dims as [number, number, number], on.axis, on.slice, loop);
    const changed = voxels.length > 0 ? context.change({ kind: 'paint', roiId, voxels }) : 0;
    this.said.set(
      voxels.length === 0
        ? 'The path encloses no voxel’s middle: nothing was filled.'
        : `${changed} voxel${changed === 1 ? '' : 's'} filled${changed < voxels.length ? `; the constraints kept ${voxels.length - changed}` : ''}.`,
    );
    this.startOver();
  }

  /** Pixels of the anchors' slice to pane pixels: affine, worked out from three points. */
  private toPane(on: On): ((point: PlanePoint) => [number, number]) | null {
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== on.axis);
    const voxel = (u: number, v: number): Vec3 => {
      const out: [number, number, number] = [0, 0, 0];
      out[on.axis] = on.slice;
      out[a] = u;
      out[b] = v;
      return out;
    };
    const o = this.brush.paneLocalOfVoxel(on.placement, voxel(0, 0));
    const ea = this.brush.paneLocalOfVoxel(on.placement, voxel(1, 0));
    const eb = this.brush.paneLocalOfVoxel(on.placement, voxel(0, 1));
    if (!o || !ea || !eb) return null;
    return ([u, v]) => [
      o.x + u * (ea.x - o.x) + v * (eb.x - o.x),
      o.y + u * (ea.y - o.y) + v * (eb.y - o.y),
    ];
  }
}

/** The live wire's options: how it is used, how many anchors, and Start over. */
@Component({
  selector: 'app-live-wire-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Live wire</legend>
      <p class="said">
        Click anchors along an edge; the path keeps to it. Click the first anchor to fill the path.
      </p>
      <div class="row">
        <span data-wire-count
          >{{ tool.anchors().length }} anchor{{ tool.anchors().length === 1 ? '' : 's' }}</span
        >
        <button
          type="button"
          data-wire-start-over
          [disabled]="tool.anchors().length === 0"
          (click)="tool.startOver()"
        >
          Start over
        </button>
      </div>
      @if (tool.said(); as text) {
        <p class="said" data-wire-said>{{ text }}</p>
      }
    </fieldset>
  `,
  styleUrls: ['../panel-card.css'],
  styles: `
    .options {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 6px 8px 8px;
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-sm);
      font-size: 13px;
    }
    legend {
      padding: 0 4px;
      font-size: 11px;
      color: var(--muted);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      color: var(--muted);
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class LiveWireOptions {
  protected readonly tool = inject(LiveWireTool);
}
