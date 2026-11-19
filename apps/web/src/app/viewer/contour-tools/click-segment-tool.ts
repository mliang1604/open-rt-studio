/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Click to segment (#340): a model outlines the object that is clicked on,
// on the slice of the pane. Clicks on the object and off it, and a box
// dragged about it, are what the model is asked; it answers with several
// readings of them, the surest first, and the others are a key away. What
// is shown is added to the structure being edited when it is accepted, as
// one edit, through the shared constraints.
//
// The model is SAM 2.1 tiny at half precision (`segment-model.ts`), run by
// an engine in a worker on WebGPU (`segment-engine.ts`). Its files are not
// in the application: until it is decided where they come from (#341), the
// user chooses them from this computer, and they are taken only when they
// are byte for byte the ones that were measured. Nothing is sent anywhere.
//
// The model sees the slice as it is shown: through the window. So the
// slice is made ready again when the window changes, which is the wait of
// this tool; a click after that is fast. Without WebGPU the tool is off and
// says why, and so it is where a page may not compile WebAssembly (a
// content policy can refuse it; the desktop application's allows it, #359).
// Of the labs: the model was trained on photographs, and nothing here says
// how good it is on a real CT or MR.

import {
  ChangeDetectionStrategy,
  Component,
  Injectable,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { slicePlane, sliceVoxelIndex, type LabelVolume } from '@open-rt-studio/dicom';
import { throughPlaneAxis } from '@open-rt-studio/render';

import { BrushController } from '../brush-controller';
import { EditableStructuresStore } from '../editable-structures-store';
import type { PanePlacement } from '../pane-placement';
import { isEditableTarget } from '../viewer-dom';
import type {
  ContourTool,
  ContourToolContext,
  ToolPointer,
  ToolPreviewCircle,
} from './contour-tool';
import { ContourToolsController } from './contour-tools-controller';
import { sliceToPane } from './plane-picture';
import { maskPath } from './quick-select-tool';
import {
  SEGMENT_ENGINE,
  SEGMENT_MODEL_FILES,
  SegmentEngineError,
  type SegmentLack,
} from './segment-engine';
import {
  SEGMENT_MODEL,
  maskOf,
  masksInOrder,
  modelFrom,
  pixelValues,
  promptOf,
  type ChosenFile,
  type SegmentAnswer,
  type SegmentBox,
  type SegmentClick,
} from './segment-model';

type MprPlacement = Extract<PanePlacement, { kind: 'mpr' }>;

/** What a click marks. */
export type SegmentMarking = 'object' | 'background';

/** Where the model stands: not chosen, being checked, being made ready, or ready. */
export type SegmentModelState = 'absent' | 'checking' | 'loading' | 'ready';

/** A press that moves further than this, in pixels of the screen, is a box and not a click. */
const BOX_FROM_PX = 6;

/** A selection under way, on one slice. */
interface Session {
  readonly placement: MprPlacement;
  readonly axis: 0 | 1 | 2;
  readonly slice: number;
  readonly width: number;
  readonly height: number;
  readonly label: LabelVolume;
  clicks: SegmentClick[];
  box: SegmentBox | null;
  /** What the model answered for the clicks and the box so far; null before the first answer. */
  answer: SegmentAnswer | null;
  /** The answer's masks, the surest first. */
  order: number[];
  /** The mask that is shown, of the slice's own pixels. */
  mask: Uint8Array | null;
}

/** A small ring about a pixel of the pane, as an SVG path: where a click was. */
function ringPath([x, y]: [number, number]): string {
  const f = (n: number): string => n.toFixed(1);
  const [outer, inner] = [5, 2.5];
  const circle = (r: number): string =>
    `M${f(x - r)} ${f(y)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  return circle(outer) + circle(inner);
}

@Injectable()
export class ClickSegmentTool implements ContourTool {
  private readonly brush = inject(BrushController);
  private readonly store = inject(EditableStructuresStore);
  private readonly engine = inject(SEGMENT_ENGINE);
  private readonly modelFiles = inject(SEGMENT_MODEL_FILES);
  private readonly injector = inject(Injector);

  readonly id = 'segment';
  readonly name = 'Click to segment';
  readonly description =
    'Click an object to have a model outline it on the slice, then add it to the structure being edited (labs)';
  readonly labs = true;
  readonly listed = true;
  readonly options = ClickSegmentOptions;

  /**
   * What this page lacks to run the model, for which the tool is off: WebGPU,
   * or leave to compile WebAssembly. Looked for when the tool is taken up.
   */
  readonly off = signal<SegmentLack | null>(null);
  /** Where the model stands. */
  readonly model = signal<SegmentModelState>('absent');
  /** Why the files chosen were not taken, or why the model could not be made ready. */
  readonly modelSaid = signal<string | null>(null);
  /** What a click marks: the object, or what is not the object. */
  readonly marking = signal<SegmentMarking>('object');
  /** What the tool is waiting for: the slice to be made ready, or the answer to a click. */
  readonly waiting = signal<'slice' | 'click' | null>(null);
  /** What came of the last click, or why nothing did. */
  readonly said = signal<string | null>(null);
  /** How long the last answer took, the slice's making ready with it, in milliseconds. */
  readonly tookMs = signal<number | null>(null);
  /** Whether a selection is under way, and whether there is a mask to accept. */
  readonly underWay = signal(false);
  readonly found = signal(false);
  /** Which of the model's masks is shown, counted from 1, and of how many. */
  readonly shown = signal<{ readonly which: number; readonly of: number } | null>(null);

  private session: Session | null = null;
  /** Counts up when what is shown changes: the selection is not a signal itself. */
  private readonly changed = signal(0);
  /** The press under way: where it began, in the slice and on the screen, and where it is. */
  private press: {
    from: [number, number];
    to: [number, number];
    screen: [number, number];
    box: boolean;
  } | null = null;
  /** Counts the questions asked of the model: an answer to an older one is let go. */
  private asked = 0;
  /** The slices made ready, by key: whether the next click waits for its slice. */
  private readonly encodedKeys = new Set<string>();
  /** An image by a number of its own, for a slice's key. */
  private readonly images = new WeakMap<Float32Array, number>();
  private imageCount = 0;
  /** The last question, settled when it is answered: for whoever waits on it (a spec). */
  working: Promise<void> | null = null;

  readonly preview = computed<ToolPreviewCircle | null>(() => {
    this.changed();
    const session = this.session;
    if (!session) return null;
    const toPane = sliceToPane(this.brush, session.placement, session.axis, session.slice);
    if (!toPane) return null;
    const rings = (on: boolean): string =>
      session.clicks
        .filter((click) => click.on === on)
        .map((click) => ringPath(toPane([click.x, click.y])))
        .join('');
    const press = this.press;
    const box: SegmentBox | null = press?.box
      ? { x0: press.from[0], y0: press.from[1], x1: press.to[0], y1: press.to[1] }
      : session.box;
    const corners = box
      ? [
          toPane([Math.min(box.x0, box.x1) - 0.5, Math.min(box.y0, box.y1) - 0.5]),
          toPane([Math.max(box.x0, box.x1) + 0.5, Math.min(box.y0, box.y1) - 0.5]),
          toPane([Math.max(box.x0, box.x1) + 0.5, Math.max(box.y0, box.y1) + 0.5]),
          toPane([Math.min(box.x0, box.x1) - 0.5, Math.max(box.y0, box.y1) + 0.5]),
        ]
      : null;
    return {
      rect: session.placement.rect,
      x: 0,
      y: 0,
      radiusPx: 0,
      marks: { object: rings(true), background: rings(false) },
      ...(session.mask ? { fill: maskPath(session.mask, session.width, toPane) } : {}),
      ...(corners
        ? { curve: `M${corners.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z` }
        : {}),
    };
  });

  editName(): string {
    return 'Click to segment';
  }

  ready(): boolean {
    return this.brush.activeRoiId() !== null;
  }

  activate(): void {
    this.brush.ensureActiveRoi();
    this.off.set(this.engine.lacks());
  }

  /**
   * Take the model's files from what was chosen: each is held to its name,
   * its size and its checksum, and then the model is made ready. What is no
   * part of the model is passed over.
   */
  async choose(files: readonly ChosenFile[]): Promise<void> {
    if (this.off() || this.model() === 'checking' || this.model() === 'loading') return;
    this.modelSaid.set(null);
    this.model.set('checking');
    try {
      const model = await modelFrom(files, this.modelFiles);
      if ('kind' in model) {
        this.model.set('absent');
        this.modelSaid.set(
          model.kind === 'missing'
            ? `Not among the files chosen: ${model.names.join(', ')}. The model is all four files.`
            : `${model.name} is not the file this tool was measured with (its size or its checksum differs), and was not taken.`,
        );
        return;
      }
      this.model.set('loading');
      await this.engine.load(model);
      this.encodedKeys.clear();
      this.model.set('ready');
      this.said.set('The model is ready. Click an object on a pane.');
    } catch (error) {
      this.model.set('absent');
      if (error instanceof SegmentEngineError && error.reason === 'no-webgpu') {
        this.off.set('webgpu');
        return;
      }
      // What the runtime said is its own text, of itself and of no image: it helps whoever reports this.
      const detail =
        error instanceof Error ? ` The runtime said: ${error.message.slice(0, 240)}` : '';
      this.modelSaid.set(`The model could not be made ready on this computer.${detail}`);
    }
  }

  begin(context: ContourToolContext, pointer: ToolPointer): void {
    this.press = null;
    if (this.off()) return;
    if (this.model() !== 'ready') {
      this.said.set('Choose the model’s files first.');
      return;
    }
    const voxel = context.voxelAt(pointer);
    const grid = context.grid();
    const label = this.store.labelVolume();
    if (!voxel || !grid || !label) return;
    const { placement } = pointer;
    if (this.brush.tiltedPlaneOf(placement)) {
      this.said.set('On a tilted pane this tool does nothing yet: use a pane that is not tilted.');
      return;
    }
    const axis = throughPlaneAxis(placement.orientation);
    const slice = voxel[axis];
    const session = this.session;
    if (
      session &&
      (session.axis !== axis ||
        session.slice !== slice ||
        session.placement.group !== placement.group ||
        session.label !== label)
    ) {
      this.discard();
      this.said.set(
        'The selection under way, on another slice, was let go: accept one before moving on.',
      );
    }
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== axis);
    if (!this.session) {
      this.session = {
        placement,
        axis,
        slice,
        width: grid.dims[a],
        height: grid.dims[b],
        label,
        clicks: [],
        box: null,
        answer: null,
        order: [],
        mask: null,
      };
      this.underWay.set(true);
    }
    const at: [number, number] = [voxel[a], voxel[b]];
    this.press = {
      from: at,
      to: at,
      screen: [pointer.event.clientX, pointer.event.clientY],
      box: false,
    };
  }

  extend(context: ContourToolContext, pointer: ToolPointer): void {
    const press = this.press;
    const session = this.session;
    const voxel = context.voxelAt(pointer);
    if (!press || !session || !voxel) return;
    const [a, b] = ([0, 1, 2] as const).filter((one) => one !== session.axis);
    press.to = [voxel[a], voxel[b]];
    const moved = Math.hypot(
      pointer.event.clientX - press.screen[0],
      pointer.event.clientY - press.screen[1],
    );
    if (moved > BOX_FROM_PX) press.box = true;
    if (press.box) this.changed.update((n) => n + 1);
  }

  /** The pointer came up: a click or a box more, and the model is asked again for all of them. */
  end(context: ContourToolContext): void {
    const press = this.press;
    const session = this.session;
    this.press = null;
    if (!press || !session) return;
    if (press.box && (press.from[0] !== press.to[0] || press.from[1] !== press.to[1])) {
      session.box = { x0: press.from[0], y0: press.from[1], x1: press.to[0], y1: press.to[1] };
    } else {
      session.clicks.push({
        x: press.from[0],
        y: press.from[1],
        on: this.marking() === 'object',
      });
    }
    this.changed.update((n) => n + 1);
    this.ask(context);
  }

  /** A press cancelled: it marks nothing. */
  cancel(): void {
    this.press = null;
    this.changed.update((n) => n + 1);
  }

  /** Ask the model about the clicks and the box so far; an answer to an earlier question is let go. */
  private ask(context: ContourToolContext): void {
    const session = this.session;
    const image = context.image();
    const grid = context.grid();
    if (!session || !image || !grid) return;
    if (!session.box && !session.clicks.some((click) => click.on)) {
      this.said.set('Click on the object too: clicks off it alone find nothing.');
      return;
    }
    const picture = slicePlane(
      image,
      grid.dims as [number, number, number],
      session.axis,
      session.slice,
    );
    if (!picture) return;
    const shown = this.brush.displayWindow();
    if (!shown) return;
    const { low, high } = shown;
    let imageId = this.images.get(image);
    if (imageId === undefined) {
      imageId = ++this.imageCount;
      this.images.set(image, imageId);
    }
    const key = `${imageId}:${session.axis}:${session.slice}:${low}:${high}`;
    const question = ++this.asked;
    const current = (): boolean => question === this.asked && this.session === session;
    const first = !this.encodedKeys.has(key);
    this.waiting.set(first ? 'slice' : 'click');
    this.said.set(
      first
        ? 'Making the slice ready for the model, as it is shown through the window…'
        : 'Asking the model…',
    );
    const started = performance.now();
    this.working = (async () => {
      try {
        if (first) {
          await this.engine.encode(
            key,
            pixelValues(picture.data, picture.width, picture.height, low, high),
          );
          this.encodedKeys.add(key);
        }
        const answer = await this.engine.decode(
          key,
          promptOf(session.clicks, session.box, session.width, session.height),
        );
        if (!current()) return;
        session.answer = answer;
        session.order = masksInOrder(answer);
        this.show(session, 0);
        const took = performance.now() - started;
        this.tookMs.set(Math.round(took));
        const seconds = (took / 1000).toFixed(1);
        this.said.set(
          this.found()
            ? `Found in ${seconds} s. Accept it, click again to correct it, or look at the model’s other masks.`
            : 'The model found nothing there. Click again, or look at its other masks.',
        );
      } catch (error) {
        if (!current()) return;
        if (error instanceof SegmentEngineError && error.reason === 'not-encoded') {
          // The slice was let go for others since: it is made ready again.
          this.encodedKeys.delete(key);
          this.said.set('The slice has to be made ready again: click once more.');
        } else {
          this.said.set('The model could not be asked.');
        }
      } finally {
        if (current()) this.waiting.set(null);
      }
    })();
  }

  /** Show one of the answer's masks, counted from the surest. */
  private show(session: Session, which: number): void {
    if (!session.answer || session.order.length === 0) return;
    const at = ((which % session.order.length) + session.order.length) % session.order.length;
    session.mask = maskOf(session.answer, session.order[at], session.width, session.height);
    this.shown.set({ which: at + 1, of: session.order.length });
    this.found.set(session.mask.includes(1));
    this.changed.update((n) => n + 1);
  }

  /** The model's next reading of the clicks, round and round. */
  nextMask(): void {
    const session = this.session;
    const shown = this.shown();
    if (!session?.answer || !shown) return;
    this.show(session, shown.which);
    this.said.set(
      this.found() ? `Mask ${this.shown()!.which} of ${shown.of}.` : 'This mask is empty.',
    );
  }

  /** Add what is shown to the structure being edited, as one edit, and end the selection. */
  accept(): number {
    const session = this.session;
    const roiId = this.brush.activeRoiId();
    // An empty mask is nothing to accept: the selection stays, for another mask or another click.
    if (!session?.mask || roiId === null || !this.found()) return 0;
    const dims = session.label.dims;
    const voxels: number[] = [];
    session.mask.forEach((inside, at) => {
      if (inside) {
        voxels.push(
          sliceVoxelIndex(
            dims,
            session.axis,
            session.slice,
            at % session.width,
            Math.floor(at / session.width),
          ),
        );
      }
    });
    this.discard();
    const changed = this.injector
      .get(ContourToolsController)
      .apply(this.editName(), [{ kind: 'paint', roiId, voxels }], this);
    this.said.set(`${changed} voxel${changed === 1 ? '' : 's'} added.`);
    return changed;
  }

  /** Let the selection under way go: nothing is added, and an answer still to come is let go. */
  discard(): void {
    this.asked++;
    this.session = null;
    this.press = null;
    this.waiting.set(null);
    this.underWay.set(false);
    this.found.set(false);
    this.shown.set(null);
    this.said.set(null);
    this.changed.update((n) => n + 1);
  }
}

/** The tool's options: the model's files, what a click marks, the model's masks, Accept and Discard. */
@Component({
  selector: 'app-click-segment-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKey($event)' },
  template: `
    <fieldset class="options">
      <legend>Click to segment</legend>
      @if (tool.off() === 'webgpu') {
        <p class="said" data-segment-off>
          This tool needs WebGPU, which this browser does not give, and is off. It does not fall
          back to the processor, where a slice would take 8 to 16 seconds.
        </p>
      } @else if (tool.off() === 'webassembly') {
        <p class="said" data-segment-off>
          This tool runs its model with WebAssembly, which this application’s content policy does
          not let a page compile, and is off here. In a browser it is not.
        </p>
      } @else if (tool.model() !== 'ready') {
        <p class="said" data-segment-model>
          The model is not in the application. It is {{ model.title }} ({{ model.licence }}), 78 MB
          in four files, published as {{ model.source }}. Choose its four files from this computer;
          they are checked against the ones this tool was measured with, and nothing is sent
          anywhere.
        </p>
        <ul class="files">
          @for (file of model.files; track file.name) {
            <li>{{ file.name }}</li>
          }
        </ul>
        <label class="row">
          <input
            type="file"
            multiple
            data-segment-files
            aria-label="The model’s four files"
            [disabled]="tool.model() !== 'absent'"
            (change)="chosen($event)"
          />
        </label>
        @if (tool.model() === 'checking') {
          <p class="said" data-segment-model-state>Checking the files…</p>
        } @else if (tool.model() === 'loading') {
          <p class="said" data-segment-model-state>
            Making the model ready: up to ten seconds the first time.
          </p>
        }
        @if (tool.modelSaid(); as text) {
          <p class="said problem" data-segment-model-said>{{ text }}</p>
        }
      } @else {
        <div class="row" role="radiogroup" aria-label="What a click marks">
          A click is
          <label>
            <input
              type="radio"
              name="segment-marking"
              data-segment-marking="object"
              [checked]="tool.marking() === 'object'"
              (change)="tool.marking.set('object')"
            />
            on the object
          </label>
          <label>
            <input
              type="radio"
              name="segment-marking"
              data-segment-marking="background"
              [checked]="tool.marking() === 'background'"
              (change)="tool.marking.set('background')"
            />
            off it
          </label>
        </div>
        <p class="hint">
          Drag for a box about the object. N switches what a click is; M shows the model’s next
          mask. The model sees the slice through the window it is shown through.
        </p>
        @if (tool.underWay()) {
          <div class="row">
            <button
              type="button"
              data-segment-accept
              [disabled]="!tool.found() || tool.waiting() !== null"
              (click)="tool.accept()"
            >
              Accept
            </button>
            <button
              type="button"
              data-segment-next
              [disabled]="!tool.shown() || tool.waiting() !== null"
              (click)="tool.nextMask()"
            >
              @if (tool.shown(); as shown) {
                Mask {{ shown.which }} of {{ shown.of }}
              } @else {
                Next mask
              }
            </button>
            <button type="button" data-segment-discard (click)="tool.discard()">Discard</button>
          </div>
        }
      }
      @if (tool.said(); as text) {
        <p
          class="said"
          data-segment-said
          [attr.aria-busy]="tool.waiting() !== null"
          [attr.data-took-ms]="tool.tookMs()"
          [textContent]="text"
        ></p>
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
      gap: 6px;
      flex-wrap: wrap;
      color: var(--muted);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    input[type='radio'] {
      margin: 0;
      padding: 0;
    }
    input[type='file'] {
      max-width: 100%;
      font-size: 12px;
    }
    .said,
    .hint {
      margin: 0;
      font-size: 12px;
      color: var(--muted);
    }
    .problem {
      color: var(--warning, #f0b429);
    }
    .files {
      margin: 0;
      padding-left: 18px;
      font-size: 11px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
  `,
})
export class ClickSegmentOptions {
  protected readonly tool = inject(ClickSegmentTool);
  protected readonly model = SEGMENT_MODEL;

  protected chosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    // The same files can be chosen again after a refusal.
    input.value = '';
    if (files.length > 0) void this.tool.choose(files);
  }

  /** N switches what a click is, M shows the next mask: while the tool is in hand, and not while typing. */
  protected onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return;
    if (this.tool.model() !== 'ready') return;
    const key = event.key.toLowerCase();
    if (key === 'm' && this.tool.shown()) {
      event.preventDefault();
      this.tool.nextMask();
    } else if (key === 'n') {
      event.preventDefault();
      this.tool.marking.update((now) => (now === 'object' ? 'background' : 'object'));
    }
  }
}
