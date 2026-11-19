/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { AXIAL_MID, TILTED_AXIAL, pointer, setup, type Obliques } from '../brush-testing';
import { ClickSegmentOptions, ClickSegmentTool } from './click-segment-tool';
import {
  SEGMENT_ENGINE,
  SEGMENT_MODEL_FILES,
  SegmentEngineError,
  type SegmentEngine,
  type SegmentLack,
} from './segment-engine';
import {
  SEGMENT_SIDE,
  sha256Hex,
  type ChosenFile,
  type SegmentAnswer,
  type SegmentModelFile,
  type SegmentPrompt,
} from './segment-model';

// The 4 × 4 × 4 test image with an edge: 0 in columns 0 and 1, 100 in columns 2 and 3.
// The axial pane is 100 px across: column 3 is at x 87.5, column 0 at 12.5, and rows the same.
const EDGE = (x: number): number => (x < 2 ? 0 : 100);

/** The column of the 4 × 4 slice a point of the model's square is in. */
const columnOf = (x: number): number => Math.floor((x * 4) / SEGMENT_SIDE);

/**
 * A stand-in for the model: its first mask is the half of the slice (left
 * or right) the first click on the object is in, or the columns of the box;
 * its second, of which it is less sure, the whole slice; its third nothing.
 */
function standIn(lacks: SegmentLack | null = null) {
  const calls = {
    loaded: 0,
    encoded: [] as string[],
    decoded: [] as { key: string; prompt: SegmentPrompt }[],
  };
  let hold: Promise<void> | null = null;
  let forgets = false;
  const engine: SegmentEngine = {
    lacks: () => lacks,
    async load() {
      calls.loaded += 1;
    },
    async encode(key, values) {
      expect(values.length).toBe(3 * SEGMENT_SIDE * SEGMENT_SIDE);
      calls.encoded.push(key);
    },
    async decode(key, prompt): Promise<SegmentAnswer> {
      calls.decoded.push({ key, prompt });
      if (hold) await hold;
      if (forgets) throw new SegmentEngineError('not-encoded', 'let go');
      const on = prompt.labels.indexOf(1);
      const columns = prompt.box
        ? [columnOf(prompt.box[0]), columnOf(prompt.box[2])]
        : columnOf(prompt.points[2 * on]) < 2
          ? [0, 1]
          : [2, 3];
      const logits = new Float32Array(3 * 16).fill(-4);
      for (let at = 0; at < 16; at++) {
        if (at % 4 >= columns[0] && at % 4 <= columns[1]) logits[at] = 4;
        logits[16 + at] = 4;
      }
      return { logits, side: 4, scores: [0.9, 0.5, 0.1] };
    },
    close() {},
  };
  return {
    engine,
    calls,
    /** Have answers wait until this is called. */
    holdAnswers(): () => void {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
    forget(): void {
      forgets = true;
    },
  };
}

/** Four small files that stand for the model's, and their list as the tool is given it. */
async function modelFiles(): Promise<{ list: SegmentModelFile[]; chosen: ChosenFile[] }> {
  const list: SegmentModelFile[] = [];
  const chosen: ChosenFile[] = [];
  for (const part of ['encoder', 'encoderData', 'decoder', 'decoderData'] as const) {
    const bytes = new TextEncoder().encode(`the ${part}`).buffer as ArrayBuffer;
    list.push({
      part,
      name: `${part}.onnx`,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
    chosen.push({
      name: `${part}.onnx`,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes,
    });
  }
  return { list, chosen };
}

describe('ClickSegmentTool (#340)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    try {
      localStorage.clear();
    } catch {
      // No storage here.
    }
  });

  async function holding(
    options: { lacks?: SegmentLack | null; load?: boolean; obliques?: Obliques } = {},
  ) {
    const model = standIn(options.lacks ?? null);
    const files = await modelFiles();
    TestBed.configureTestingModule({
      providers: [
        { provide: SEGMENT_ENGINE, useValue: model.engine },
        { provide: SEGMENT_MODEL_FILES, useValue: files.list },
      ],
    });
    const made = setup(undefined, EDGE, [], [2, 2, 2], options.obliques);
    made.tools.setLabs(true);
    made.tools.toggle('segment');
    const tool = TestBed.inject(ClickSegmentTool);
    if (options.load !== false) await tool.choose(files.chosen);
    const label = made.store.labelVolume()!;
    const roiId = made.brush.activeRoiId()!;
    const has = () => [...label.data].filter((value) => value === roiId).length;
    const click = async (x: number, y = 50) => {
      made.tools.begin(AXIAL_MID, pointer(x, y));
      made.tools.end();
      await tool.working;
    };
    return { ...made, ...model, files, tool, has, click };
  }

  it('is offered with the labs flag and makes ready a structure', async () => {
    const { tools, brush } = await holding({ load: false });
    expect(tools.listed().map((tool) => tool.id)).toContain('segment');
    expect(tools.held()?.id).toBe('segment');
    expect(brush.activeRoiId()).not.toBeNull();
    tools.setLabs(false);
    expect(tools.listed().map((tool) => tool.id)).not.toContain('segment');
  });

  it('does nothing before it has its model, and says so', async () => {
    const { tool, click, calls, tools } = await holding({ load: false });
    expect(tool.model()).toBe('absent');
    await click(87.5);
    expect(tool.said()).toBe('Choose the model’s files first.');
    expect(calls.encoded).toEqual([]);
    expect(tool.underWay()).toBe(false);
    expect(tools.nextUndo()).toBeNull();
  });

  it('takes its model only from files that are the model’s', async () => {
    const { tool, files, calls } = await holding({ load: false });
    await tool.choose(files.chosen.slice(0, 3));
    expect(tool.model()).toBe('absent');
    expect(tool.modelSaid()).toBe(
      'Not among the files chosen: decoderData.onnx. The model is all four files.',
    );
    const other = new TextEncoder().encode('the encodeR').buffer as ArrayBuffer;
    await tool.choose([
      { name: 'encoder.onnx', size: other.byteLength, arrayBuffer: async () => other },
      ...files.chosen.slice(1),
    ]);
    expect(tool.modelSaid()).toBe(
      'encoder.onnx is not the file this tool was measured with (its size or its checksum differs), and was not taken.',
    );
    expect(calls.loaded).toBe(0);
    await tool.choose(files.chosen);
    expect(calls.loaded).toBe(1);
    expect(tool.model()).toBe('ready');
    expect(tool.modelSaid()).toBeNull();
    expect(tool.said()).toBe('The model is ready. Click an object on a pane.');
  });

  it('is off where the page has no WebGPU, or may not compile WebAssembly', async () => {
    for (const lacks of ['webgpu', 'webassembly'] as const) {
      const { tool, files, click, calls } = await holding({ lacks, load: false });
      expect(tool.off()).toBe(lacks);
      await tool.choose(files.chosen);
      expect(calls.loaded).toBe(0);
      await click(87.5);
      expect(calls.encoded).toEqual([]);
      expect(tool.underWay()).toBe(false);
      const options = TestBed.createComponent(ClickSegmentOptions);
      options.detectChanges();
      const said = (options.nativeElement as HTMLElement).querySelector('[data-segment-off]')!;
      expect(said.textContent).toContain(lacks === 'webgpu' ? 'needs WebGPU' : 'content policy');
      expect(
        (options.nativeElement as HTMLElement).querySelector('[data-segment-files]'),
      ).toBeNull();
      TestBed.resetTestingModule();
    }
  });

  it('shows what the model finds for a click, and adds it when it is accepted, as one edit', async () => {
    const { tool, click, has, tools, calls } = await holding();
    await click(87.5);
    expect(calls.encoded).toHaveLength(1);
    expect(calls.decoded).toHaveLength(1);
    // The click as the model takes it: the middle of column 3 and of row 2, of 4 each.
    expect(Array.from(calls.decoded[0].prompt.points)).toEqual([896, 640]);
    expect(calls.decoded[0].prompt.labels).toEqual([1]);
    expect(calls.decoded[0].prompt.box).toBeNull();
    expect(tool.shown()).toEqual({ which: 1, of: 3 });
    expect(tool.found()).toBe(true);
    expect(tool.said()).toMatch(/^Found in \d+\.\d s\./);
    expect(tool.preview()?.fill).toBeTruthy();
    expect(tool.preview()?.marks?.object).toBeTruthy();
    // Nothing is changed until it is accepted.
    expect(has()).toBe(0);
    expect(tools.nextUndo()).toBeNull();
    expect(tool.accept()).toBe(8);
    expect(has()).toBe(8);
    expect(tool.said()).toBe('8 voxels added.');
    expect(tool.underWay()).toBe(false);
    expect(tool.preview()).toBeNull();
    expect(tools.nextUndo()).toBe('Click to segment');
    tools.undo();
    expect(has()).toBe(0);
  });

  it('makes a slice ready once, and again when the window it is shown through changes', async () => {
    const { tool, click, calls, brush } = await holding();
    await click(87.5);
    await click(62.5);
    expect(calls.encoded).toHaveLength(1);
    expect(calls.decoded).toHaveLength(2);
    // Both clicks are asked about together.
    expect(calls.decoded[1].prompt.labels).toEqual([1, 1]);
    tool.discard();
    await click(87.5);
    expect(calls.encoded).toHaveLength(1);
    (brush as unknown as { displayWindow: () => unknown }).displayWindow = () => ({
      low: -160,
      high: 240,
    });
    await click(62.5);
    expect(calls.encoded).toHaveLength(2);
    expect(calls.encoded[1]).not.toBe(calls.encoded[0]);
  });

  it('steps through the model’s masks, the surest first, round and round', async () => {
    const { tool, click, has } = await holding();
    await click(12.5);
    tool.nextMask();
    expect(tool.shown()).toEqual({ which: 2, of: 3 });
    expect(tool.said()).toBe('Mask 2 of 3.');
    tool.nextMask();
    expect(tool.shown()).toEqual({ which: 3, of: 3 });
    expect(tool.found()).toBe(false);
    expect(tool.said()).toBe('This mask is empty.');
    expect(tool.accept()).toBe(0);
    tool.nextMask();
    tool.nextMask();
    expect(tool.shown()).toEqual({ which: 2, of: 3 });
    expect(tool.accept()).toBe(16);
    expect(has()).toBe(16);
  });

  it('takes clicks off the object with those on it, and asks nothing for those alone', async () => {
    const { tool, click, calls } = await holding();
    tool.marking.set('background');
    await click(12.5);
    expect(calls.decoded).toHaveLength(0);
    expect(tool.said()).toBe('Click on the object too: clicks off it alone find nothing.');
    expect(tool.preview()?.marks?.background).toBeTruthy();
    tool.marking.set('object');
    await click(87.5);
    expect(calls.decoded[0].prompt.labels).toEqual([0, 1]);
  });

  it('takes a drag for a box about the object', async () => {
    const { tool, tools, calls, has } = await holding();
    tools.begin(AXIAL_MID, pointer(37.5, 12.5));
    tools.extend(AXIAL_MID, pointer(87.5, 87.5));
    expect(tool.preview()?.curve).toBeTruthy();
    tools.end();
    await tool.working;
    const { prompt } = calls.decoded[0];
    expect(prompt.labels).toEqual([-1]);
    // Columns 1 to 3, rows 0 to 3, in the model's square.
    expect(Array.from(prompt.box!)).toEqual([384, 128, 896, 896]);
    expect(tool.accept()).toBe(12);
    expect(has()).toBe(12);
  });

  it('lets go of an answer that comes after the selection was discarded', async () => {
    const { tool, tools, holdAnswers, has } = await holding();
    const release = holdAnswers();
    tools.begin(AXIAL_MID, pointer(87.5, 50));
    tools.end();
    expect(tool.waiting()).toBe('slice');
    tool.discard();
    release();
    await tool.working;
    expect(tool.waiting()).toBeNull();
    expect(tool.shown()).toBeNull();
    expect(tool.preview()).toBeNull();
    expect(tool.accept()).toBe(0);
    expect(has()).toBe(0);
  });

  it('says so when the slice was let go for others, and makes it ready again at the next click', async () => {
    const { tool, click, calls, forget } = await holding();
    await click(87.5);
    forget();
    await click(62.5);
    expect(tool.said()).toBe('The slice has to be made ready again: click once more.');
    expect(tool.waiting()).toBeNull();
    await click(62.5).catch(() => undefined);
    expect(calls.encoded).toHaveLength(2);
  });

  it('goes through the constraints every tool keeps to', async () => {
    const { tool, click, has, tools, store, brush } = await holding();
    // Another structure holds column 3; with the others protected, it keeps it.
    const first = brush.activeRoiId()!;
    await click(87.5);
    tool.accept();
    expect(has()).toBe(8);
    brush.newStructure(false);
    const second = brush.activeRoiId()!;
    expect(second).not.toBe(first);
    tools.protectOthers.set(true);
    await click(87.5);
    tool.nextMask();
    // The whole slice was found; half of it is the first structure's.
    expect(tool.accept()).toBe(8);
    const label = store.labelVolume()!;
    expect([...label.data].filter((value) => value === first)).toHaveLength(8);
    expect([...label.data].filter((value) => value === second)).toHaveLength(8);
  });

  it('does nothing on a tilted pane yet, and says so', async () => {
    const { tool, click, calls } = await holding({ obliques: TILTED_AXIAL });
    await click(87.5);
    expect(tool.said()).toBe(
      'On a tilted pane this tool does nothing yet: use a pane that is not tilted.',
    );
    expect(calls.encoded).toEqual([]);
  });

  it('shows its options: the model’s files to choose, then what a click is and what to do with what was found', async () => {
    const { tool, click, files } = await holding({ load: false });
    const options = TestBed.createComponent(ClickSegmentOptions);
    options.detectChanges();
    const root = options.nativeElement as HTMLElement;
    expect(root.querySelector('[data-segment-model]')!.textContent).toContain(
      'SAM 2.1 tiny, half precision (Apache 2.0), 78 MB in four files',
    );
    expect(root.querySelectorAll('.files li')).toHaveLength(4);
    expect(root.querySelector('[data-segment-accept]')).toBeNull();
    await tool.choose(files.chosen);
    await click(87.5);
    options.detectChanges();
    expect(root.querySelector('[data-segment-files]')).toBeNull();
    expect(root.querySelector('[data-segment-next]')!.textContent).toContain('Mask 1 of 3');
    // M shows the next mask and N switches what a click is; not while typing.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(tool.shown()).toEqual({ which: 2, of: 3 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N' }));
    expect(tool.marking()).toBe('background');
    const field = document.createElement('input');
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    field.remove();
    expect(tool.marking()).toBe('background');
    (root.querySelector('[data-segment-accept]') as HTMLButtonElement).click();
    options.detectChanges();
    expect(root.querySelector('[data-segment-said]')!.textContent).toBe('16 voxels added.');
  });
});
