/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference lib="webworker" />

// The click-to-segment model off the page's own thread (#340): ONNX Runtime
// Web on WebGPU, with the model's two networks. The runtime is fetched when
// the model is first loaded and never before, and it runs on WebGPU or not
// at all: on the processor a slice would take 8 to 16 s
// (docs/click-to-segment.md). What is made of a slice by the encoder stays
// here, under a key, for the clicks that follow.

import type * as Ort from 'onnxruntime-web/webgpu';

import type { SegmentAnswer, SegmentModelBytes, SegmentPrompt } from './segment-model';
import { SEGMENT_MODEL, SEGMENT_SIDE } from './segment-model';

/** What is asked of the worker. */
export type SegmentJob =
  | {
      readonly id: number;
      readonly kind: 'load';
      readonly model: SegmentModelBytes;
      /**
       * Where the runtime's WebAssembly file is served, as a folder's
       * address: the build puts it beside the application (`ort/`), and a
       * worker does not know where that is.
       */
      readonly runtime: string;
    }
  | {
      readonly id: number;
      readonly kind: 'encode';
      readonly key: string;
      readonly values: Float32Array;
    }
  | {
      readonly id: number;
      readonly kind: 'decode';
      readonly key: string;
      readonly prompt: SegmentPrompt;
    };

/** What comes of a {@link SegmentJob}; the worker never throws across the boundary. */
export type SegmentReply =
  | { readonly id: number; readonly ok: true; readonly answer?: SegmentAnswer }
  | {
      readonly id: number;
      readonly ok: false;
      /** `no-webgpu`: there is no adapter here. `not-encoded`: the slice was let go. */
      readonly reason: 'no-webgpu' | 'not-loaded' | 'not-encoded' | 'failed';
      readonly message: string;
    };

/** How many slices' encodings are kept: each is 17 MB. */
const KEPT = 4;

let ort: typeof Ort | null = null;
let encoder: Ort.InferenceSession | null = null;
let decoder: Ort.InferenceSession | null = null;
/** What the encoder made of each slice, the one used longest ago first. */
const encoded = new Map<string, Record<string, Ort.Tensor>>();

class Refused extends Error {
  constructor(readonly reason: Extract<SegmentReply, { ok: false }>['reason']) {
    super(reason);
  }
}

async function load(model: SegmentModelBytes, runtime: string): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu || !(await gpu.requestAdapter({ powerPreference: 'high-performance' }))) {
    throw new Refused('no-webgpu');
  }
  ort ??= await import('onnxruntime-web/webgpu');
  // One thread: a page is given more only when it is cross-origin isolated.
  ort.env.wasm.numThreads = 1;
  // The file alone: the runtime's own JavaScript is in this worker's bundle.
  ort.env.wasm.wasmPaths = { wasm: `${runtime}ort-wasm-simd-threaded.asyncify.wasm` };
  ort.env.webgpu.powerPreference = 'high-performance';
  const session = (
    graph: ArrayBuffer,
    data: ArrayBuffer,
    name: string,
  ): Promise<Ort.InferenceSession> =>
    ort!.InferenceSession.create(new Uint8Array(graph), {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
      externalData: [{ path: name, data: new Uint8Array(data) }],
    });
  const nameOf = (part: 'encoderData' | 'decoderData'): string =>
    SEGMENT_MODEL.files.find((file) => file.part === part)!.name;
  encoded.clear();
  encoder = await session(model.encoder, model.encoderData, nameOf('encoderData'));
  decoder = await session(model.decoder, model.decoderData, nameOf('decoderData'));
}

async function encode(key: string, values: Float32Array): Promise<void> {
  if (!ort || !encoder) throw new Refused('not-loaded');
  if (encoded.has(key)) return;
  const made = await encoder.run({
    pixel_values: new ort.Tensor('float32', values, [1, 3, SEGMENT_SIDE, SEGMENT_SIDE]),
  });
  encoded.set(key, made as Record<string, Ort.Tensor>);
  while (encoded.size > KEPT) {
    const [oldest, tensors] = encoded.entries().next().value!;
    for (const tensor of Object.values(tensors)) tensor.dispose();
    encoded.delete(oldest);
  }
}

async function decode(key: string, prompt: SegmentPrompt): Promise<SegmentAnswer> {
  if (!ort || !decoder) throw new Refused('not-loaded');
  const of = encoded.get(key);
  if (!of) throw new Refused('not-encoded');
  // Used now: the last to be let go.
  encoded.delete(key);
  encoded.set(key, of);
  const count = prompt.labels.length;
  const feeds: Record<string, Ort.Tensor> = {
    input_points: new ort.Tensor('float32', prompt.points, [1, 1, count, 2]),
    input_labels: new ort.Tensor('int64', BigInt64Array.from(prompt.labels.map(BigInt)), [
      1,
      1,
      count,
    ]),
  };
  for (const name of decoder.inputNames) {
    if (name in feeds) continue;
    if (name === 'input_boxes') {
      feeds[name] = prompt.box
        ? new ort.Tensor('float32', prompt.box, [1, 1, 4])
        : new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]);
    } else if (name in of) {
      feeds[name] = of[name];
    } else {
      throw new Error(`The decoder asks for ${name}, which the encoder does not give.`);
    }
  }
  const out = await decoder.run(feeds);
  const masks = out['pred_masks'];
  const dims = masks.dims;
  const side = dims[dims.length - 1];
  const many = dims[dims.length - 3];
  return {
    logits: Float32Array.from(masks.data as Float32Array).subarray(0, many * side * side),
    side,
    scores: Array.from(out['iou_scores'].data as Float32Array).slice(0, many),
  };
}

// One at a time, in the order asked: a click waits for its slice.
let last: Promise<void> = Promise.resolve();

addEventListener('message', (event: MessageEvent<SegmentJob>) => {
  const job = event.data;
  last = last.then(async () => {
    try {
      if (job.kind === 'load') {
        await load(job.model, job.runtime);
        postMessage({ id: job.id, ok: true } satisfies SegmentReply);
      } else if (job.kind === 'encode') {
        await encode(job.key, job.values);
        postMessage({ id: job.id, ok: true } satisfies SegmentReply);
      } else {
        const answer = await decode(job.key, job.prompt);
        postMessage({ id: job.id, ok: true, answer } satisfies SegmentReply, [
          answer.logits.buffer,
        ]);
      }
    } catch (error) {
      postMessage({
        id: job.id,
        ok: false,
        reason: error instanceof Refused ? error.reason : 'failed',
        message: error instanceof Error ? error.message : String(error),
      } satisfies SegmentReply);
    }
  });
});
