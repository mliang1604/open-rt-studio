/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Quick select (#119, #291, #292; of the labs): stroke roughly over an object
// on a slice, and over what is not the object if it helps; after each stroke
// the object is looked for by a random walker (`random-walker.ts`) in a
// worker, and shown over the pane. Strokes add up. Accept adds what was found
// to the structure being edited, as one edit through the shared constraints;
// Discard lets it go. Nothing touches the structure until Accept.
//
// A selection is of one slice, across the axis the pane steps through. A
// stroke on another slice or pane lets the one under way go, and says so.
// On a tilted pane (#307) it is of the pane's own plane: the strokes and the
// image are in the plane's picture, and what is accepted is put into the
// grid through the voxels of the plane's sheet.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  QUICK_SELECT_BETA,
  planeImage,
  sameGridPlane,
  sheetVoxels,
  sliceVoxelIndex,
  slicePlane,
  strokePixels,
  type LabelVolume,
  type Orientation,
  type PlanePoint,
  type PlaneSpan,
} from '@open-rt-studio/dicom';
import { strokeVoxels, throughPlaneAxis, type VoxelIndex } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { PanePlacement } from '../pane-placement';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';
import { picturePixelOf, pictureToPane, planePictureOf, type PlanePicture } from './plane-picture';
import { quickSelectInWorker, warmQuickSelectWorker } from './quick-select-in-worker';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** What a stroke marks. */
export type QuickSelectMarking = 'object' | 'background';

/** A selection under way, on one slice. */
interface Session {
  readonly placement: MprPlacement;
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
  readonly width: number;
  readonly height: number;
  /** The strokes over the object, and over what is not, in the slice's pixels. */
  readonly object: Uint8Array;
  readonly background: Uint8Array;
  /** What was found for the strokes so far; null before the first search ends. */
  selection: Uint8Array | null;
  readonly label: LabelVolume;
  /** A tilted pane's plane as a picture (#307), which the selection is then in, in place of the slice. */
  readonly plane: PlanePicture | null;
}

/** An SVG path of a slice mask's pixels, each run of a row one quadrilateral, through `toPane`. */
export function maskPath(
  mask: Uint8Array,
  width: number,
  toPane: (point: PlanePoint) => [number, number],
): string {
  const parts: string[] = [];
  const height = mask.length / width;
  const f = (n: number): string => n.toFixed(1);
  for (let v = 0; v < height; v++) {
    let u = 0;
    while (u < width) {
      if (!mask[v * width + u]) {
        u++;
        continue;
      }
      const from = u;
      while (u < width && mask[v * width + u]) u++;
      const corners = [
        toPane([from - 0.5, v - 0.5]),
        toPane([u - 0.5, v - 0.5]),
        toPane([u - 0.5, v + 0.5]),
        toPane([from - 0.5, v + 0.5]),
      ];
      parts.push(`M${corners.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`);
    }
  }
  return parts.join('');
}

@Injectable()
export class QuickSelectTool implements ContourTool {
  private readonly brush = inject(BrushController);
  private readonly store = inject(EditableStructuresStore);
  private readonly injector = inject(Injector);

  readonly id = 'quick';
  readonly name = 'Quick select';
  readonly description =
    'Stroke over an object, and over what is not if it helps; the object is found as you go, and Accept adds it (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = QuickSelectOptions;

  /** What strokes mark. */
  readonly marking = signal<QuickSelectMarking>('object');
  /** How far beyond the strokes the object may reach, in mm. */
  readonly marginMm = signal<number | null>(30);
  /** How sharply an edge stops the walk. */
  readonly beta = signal<number | null>(QUICK_SELECT_BETA);
  readonly said = signal<string | null>(null);

  private session: Session | null = null;
  /** One more each time the session changes, for the preview. */
  private readonly changed = signal(0);
  /** Whether a selection is under way, and whether something was found to accept. */
  readonly underWay = signal(false);
  readonly found = signal(false);

  /** The stroke under way: what it marks, the voxel it was last at, and the marks before it. */
  private stroke: {
    last: VoxelIndex;
    /** On a tilted pane: where the stroke was last, in pixels of the plane's picture. */
    lastPixel: PlanePoint | null;
    before: { object: Uint8Array; background: Uint8Array };
  } | null = null;
  /** The search under way, to abandon. */
  private searching: AbortController | null = null;
  /** The last search, settled when it is done: for whoever waits on it (a spec). */
  working: Promise<void> | null = null;

  private readonly at = signal<{
    readonly rect: ToolPreviewCircle['rect'];
    readonly x: number;
    readonly y: number;
    readonly mmPerPixel: number;
  } | null>(null);

  /** The brush's outline where the pointer is; the strokes and what was found, over their pane. */
  readonly preview = computed<ToolPreviewCircle | null>(() => {
    this.changed();
    const at = this.at();
    const session = this.session;
    const outline = at
      ? { rect: at.rect, x: at.x, y: at.y, radiusPx: this.brush.radiusMm() / at.mmPerPixel }
      : null;
    if (!session) return outline;
    const toPane = this.toPane(session);
    if (!toPane) return outline;
    const shown = {
      marks: {
        object: maskPath(session.object, session.width, toPane),
        background: maskPath(session.background, session.width, toPane),
      },
      ...(session.selection ? { fill: maskPath(session.selection, session.width, toPane) } : {}),
    };
    // Over the session's pane: the outline there too, when the pointer is on it.
    const onPane = at && at.rect === session.placement.rect;
    return {
      rect: session.placement.rect,
      x: onPane ? at.x : 0,
      y: onPane ? at.y : 0,
      radiusPx: onPane ? outline!.radiusPx : 0,
      ...shown,
    };
  });

  editName(): string {
    return 'Quick select';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
    // The worker is started now, so that the first stroke does not wait for it (#291).
    warmQuickSelectWorker();
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    const grid = context.grid();
    const label = this.store.labelVolume();
    this.stroke = null;
    if (!voxel || !grid || !label) return;
    const { placement } = pointer;
    const axis = throughPlaneAxis(placement.orientation);
    const slice = voxel[axis];
    const picture = planePictureOf(this.brush, placement);
    const session = this.session;
    if (
      session &&
      (session.axis !== axis ||
        (picture
          ? !session.plane || !sameGridPlane(session.plane.stamp, picture.stamp)
          : session.plane !== null || session.slice !== slice) ||
        session.placement.group !== placement.group ||
        session.label !== label)
    ) {
      this.discard();
      this.said.set(
        'The selection under way, on another slice, was let go: accept one before moving on.',
      );
    }
    if (!this.session) {
      const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
      const [width, height] = picture
        ? [picture.width, picture.height]
        : [grid.dims[a], grid.dims[b]];
      this.session = {
        placement,
        axis,
        slice,
        width,
        height,
        object: new Uint8Array(width * height),
        background: new Uint8Array(width * height),
        selection: null,
        label,
        plane: picture,
      };
      this.underWay.set(true);
    }
    const now = this.session;
    const pixel = this.pixelAt(now, pointer);
    this.stroke = {
      last: voxel,
      lastPixel: pixel,
      before: { object: Uint8Array.from(now.object), background: Uint8Array.from(now.background) },
    };
    this.mark(context, placement.orientation, voxel, voxel, pixel, pixel);
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    this.hover(context, pointer);
    const voxel = context.voxelAt(pointer);
    const stroke = this.stroke;
    if (!voxel || !stroke) return;
    const pixel = this.session ? this.pixelAt(this.session, pointer) : null;
    this.mark(
      context,
      pointer.placement.orientation,
      stroke.last,
      voxel,
      stroke.lastPixel ?? pixel,
      pixel,
    );
    stroke.last = voxel;
    stroke.lastPixel = pixel ?? stroke.lastPixel;
  }

  /** The pointer came up: the object is looked for again, for all the strokes so far. */
  end(context: ContourToolContext): void {
    this.stroke = null;
    this.search(context);
  }

  /** A stroke cancelled: its marks are taken back. */
  cancel(): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (stroke && this.session) {
      this.session.object.set(stroke.before.object);
      this.session.background.set(stroke.before.background);
      this.changed.update((n) => n + 1);
    }
  }

  /** Add what was found to the structure being edited, as one edit, and end the selection. */
  accept(): number {
    const session = this.session;
    const roiId = this.brush.activeRoiId();
    if (!session?.selection || roiId === null) return 0;
    const dims = session.label.dims;
    const { selection, plane } = session;
    const voxels: number[] = [];
    if (plane) {
      // Every voxel of the plane's sheet whose pixel of the picture was found.
      const sheet = sheetVoxels(dims, session.label.spacing, plane.span, plane);
      sheet.voxels.forEach((index, n) => {
        if (selection[sheet.pixels[n]]) voxels.push(index);
      });
    }
    selection.forEach((v, k) => {
      if (v && !plane)
        voxels.push(
          sliceVoxelIndex(
            dims,
            session.axis,
            session.slice,
            k % session.width,
            Math.floor(k / session.width),
          ),
        );
    });
    this.discard();
    const changed = this.injector
      .get(ContourToolsController)
      .apply(this.editName(), [{ kind: 'paint', roiId, voxels }]);
    this.said.set(`${changed} voxel${changed === 1 ? '' : 's'} added.`);
    return changed;
  }

  /** Let the selection under way go: nothing is added. */
  discard(): void {
    this.searching?.abort();
    this.searching = null;
    this.session = null;
    this.stroke = null;
    this.underWay.set(false);
    this.found.set(false);
    this.said.set(null);
    this.changed.update((n) => n + 1);
  }

  hover(_context: ContourToolContext, pointer: ToolPointer | null): void {
    if (!pointer) {
      this.at.set(null);
      return;
    }
    const mmPerPixel = this.brush.mmPerPixel(pointer.placement);
    const local = this.brush.paneLocal(pointer);
    this.at.set(
      mmPerPixel > 0 && local
        ? { rect: pointer.placement.rect, x: local.x, y: local.y, mmPerPixel }
        : null,
    );
  }

  /** Look for the object for the strokes so far, in a worker; a search before is abandoned. */
  private search(context: ContourToolContext): void {
    const session = this.session;
    const image = context.image();
    const grid = context.grid();
    const [margin, beta] = [this.marginMm(), this.beta()];
    if (!session || !image || !grid) return;
    if (margin === null || margin <= 0 || beta === null || beta <= 0) {
      this.said.set('Type a margin and an edge sharpness, each more than 0.');
      return;
    }
    if (!session.object.includes(1)) {
      this.said.set(
        'Stroke over the object too: strokes over what is not the object alone find nothing.',
      );
      return;
    }
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== session.axis);
    const pixelMm = session.plane
      ? Math.min(...session.plane.pixelMm)
      : Math.min(grid.spacing[a], grid.spacing[b]);
    const dims = grid.dims as [number, number, number];
    const picture = session.plane
      ? planeImage(image, dims, grid.spacing, session.plane.span)
      : slicePlane(image, dims, session.axis, session.slice);
    if (!picture) return;
    this.searching?.abort();
    const abandon = new AbortController();
    this.searching = abandon;
    this.said.set('Looking for the object…');
    const started = performance.now();
    const request = {
      plane: { data: picture.data, width: picture.width, height: picture.height },
      stroke: Uint8Array.from(session.object),
      background: session.background.includes(1) ? Uint8Array.from(session.background) : undefined,
      marginPx: margin / pixelMm,
      beta,
    };
    this.working = quickSelectInWorker(request, abandon.signal)
      .then((selection) => {
        if (abandon.signal.aborted || this.session !== session || !selection) return;
        this.searching = null;
        session.selection = selection.mask;
        this.found.set(true);
        this.changed.update((n) => n + 1);
        const count = selection.mask.reduce((sum, v) => sum + v, 0);
        const took = Math.round(performance.now() - started);
        this.said.set(
          // On a tilted plane what is found is pixels of its picture; the voxels are counted when added.
          `${count} ${session.plane ? 'pixels of the plane' : 'voxels'} found in ${took} ms: Accept adds them.` +
            (selection.touchesBox
              ? ' They reach the edge of the area looked in, and may be cut off there: a stroke over what is not the object beyond it helps.'
              : ''),
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.searching = null;
        this.said.set(
          `The object could not be found: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** A tilted pane's own plane, which the selection is of (#307): the controller keeps it. */
  drawsOnPlane(placement: ToolPointer['placement']): PlaneSpan | null {
    return this.brush.tiltedPlaneOf(placement)?.span ?? null;
  }

  /** Where the pointer is in the session's picture of a tilted plane, in pixels; null on a slice. */
  private pixelAt(session: Session, pointer: ToolPointer): PlanePoint | null {
    const local = this.brush.paneLocal(pointer);
    if (!session.plane || !local) return null;
    const { rect } = pointer.placement;
    const voxel = this.brush.continuousVoxelAtCanvas(
      pointer.placement,
      rect.x + local.x,
      rect.y + local.y,
    );
    return voxel ? picturePixelOf(session.plane, this.brush.voxelSpacing(), voxel) : null;
  }

  /**
   * Mark the brush's disc from `from` to `to`, on the session's slice, as
   * what is being marked; on a tilted plane, from one pixel of its picture
   * to another.
   */
  private mark(
    context: ContourToolContext,
    orientation: Orientation,
    from: VoxelIndex,
    to: VoxelIndex,
    fromPixel: PlanePoint | null,
    toPixel: PlanePoint | null,
  ): void {
    const grid = context.grid();
    const session = this.session;
    if (!grid || !session) return;
    if (session.plane) {
      if (!fromPixel || !toPixel) return;
      const marked = this.marking() === 'object' ? session.object : session.background;
      for (const pixel of strokePixels(session.plane, fromPixel, toPixel, this.brush.radiusMm())) {
        marked[pixel] = 1;
      }
      this.changed.update((n) => n + 1);
      return;
    }
    const voxels = strokeVoxels(grid.dims, grid.spacing, from, to, {
      shape: 'disk',
      radiusMm: this.brush.radiusMm(),
      axis: throughPlaneAxis(orientation),
    });
    const [nx, ny] = grid.dims;
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== session.axis);
    const into = this.marking() === 'object' ? session.object : session.background;
    for (const i of voxels) {
      const at = [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
      into[at[b] * session.width + at[a]] = 1;
    }
    this.changed.update((n) => n + 1);
  }

  /** Pixels of the session's slice to pixels of its pane: affine, from three points. */
  private toPane(session: Session): ((point: PlanePoint) => [number, number]) | null {
    if (session.plane) return pictureToPane(this.brush, session.placement, session.plane);
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== session.axis);
    const voxel = (u: number, v: number): [number, number, number] => {
      const out: [number, number, number] = [0, 0, 0];
      out[session.axis] = session.slice;
      out[a] = u;
      out[b] = v;
      return out;
    };
    const o = this.brush.paneLocalOfVoxel(session.placement, voxel(0, 0));
    const ea = this.brush.paneLocalOfVoxel(session.placement, voxel(1, 0));
    const eb = this.brush.paneLocalOfVoxel(session.placement, voxel(0, 1));
    if (!o || !ea || !eb) return null;
    return ([u, v]) => [
      o.x + u * (ea.x - o.x) + v * (eb.x - o.x),
      o.y + u * (ea.y - o.y) + v * (eb.y - o.y),
    ];
  }
}

/** The quick selection's options: what strokes mark, the margin, the sharpness, Accept and Discard. */
@Component({
  selector: 'app-quick-select-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset class="options">
      <legend>Quick select</legend>
      <div class="row" role="radiogroup" aria-label="What strokes mark">
        Strokes mark
        <label>
          <input
            type="radio"
            name="quick-marking"
            data-quick-marking="object"
            [checked]="tool.marking() === 'object'"
            (change)="tool.marking.set('object')"
          />
          the object
        </label>
        <label>
          <input
            type="radio"
            name="quick-marking"
            data-quick-marking="background"
            [checked]="tool.marking() === 'background'"
            (change)="tool.marking.set('background')"
          />
          what is not
        </label>
      </div>
      <label class="row">
        Within
        <input
          type="number"
          min="1"
          data-quick-margin
          aria-label="How far beyond the strokes the object may reach, in mm"
          [value]="tool.marginMm() ?? ''"
          (change)="tool.marginMm.set(typed($event))"
        />
        mm of the strokes
      </label>
      <label class="row">
        Edge sharpness
        <input
          type="number"
          min="1"
          data-quick-beta
          aria-label="Edge sharpness"
          [value]="tool.beta() ?? ''"
          (change)="tool.beta.set(typed($event))"
        />
      </label>
      @if (tool.underWay()) {
        <div class="actions">
          <button
            type="button"
            data-quick-accept
            [disabled]="!tool.found()"
            (click)="tool.accept()"
          >
            Accept
          </button>
          <button type="button" data-quick-discard (click)="tool.discard()">Discard</button>
        </div>
      }
      @if (tool.said(); as text) {
        <p class="said" data-quick-said>{{ text }}</p>
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
    .row,
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--muted);
    }
    .actions button {
      flex: 1 1 0;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    input[type='number'] {
      width: 64px;
      padding: 3px 6px;
    }
    input[type='radio'] {
      margin: 0;
      padding: 0;
    }
    .said {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
  `,
})
export class QuickSelectOptions {
  protected readonly tool = inject(QuickSelectTool);

  protected typed(event: Event): number | null {
    const text = (event.target as HTMLInputElement).value.trim();
    const value = text === '' ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : null;
  }
}
