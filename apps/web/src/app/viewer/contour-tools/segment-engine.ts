/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What runs the click-to-segment model (#340), as the tool sees it: load the
// model, make a slice ready, ask about clicks. The one there is runs in a
// worker (`segment.worker.ts`); a spec gives a stand-in, since the model's
// files are not in the repository.

import { InjectionToken } from '@angular/core';

import {
  SEGMENT_MODEL,
  type SegmentAnswer,
  type SegmentModelBytes,
  type SegmentModelFile,
  type SegmentPrompt,
} from './segment-model';
import type { SegmentJob, SegmentReply } from './segment.worker';

/** Why the engine could not do what was asked. */
export class SegmentEngineError extends Error {
  constructor(
    readonly reason: Extract<SegmentReply, { ok: false }>['reason'],
    message: string,
  ) {
    super(message);
  }
}

/** What a page may lack to run the model. */
export type SegmentLack = 'webgpu' | 'webassembly';

/** The smallest WebAssembly module there is: its header and nothing else. */
const EMPTY_MODULE = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

/** What this page lacks to run a model on WebGPU with a WebAssembly runtime, or null. */
export function pageLacks(): SegmentLack | null {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return 'webgpu';
  try {
    new WebAssembly.Module(EMPTY_MODULE);
  } catch {
    return 'webassembly';
  }
  return null;
}

/** What runs the model. Every call rejects with a {@link SegmentEngineError} when it cannot. */
export interface SegmentEngine {
  /**
   * What this page lacks to run the model at all, or null: WebGPU, or
   * leave to compile WebAssembly (a content policy may refuse it; the
   * desktop application's allows it, #359). Asked when the tool is taken up, not
   * before: a policy that refuses says so in the console.
   */
  lacks(): SegmentLack | null;
  /** Take the model's files and make it ready: seconds. */
  load(model: SegmentModelBytes): Promise<void>;
  /** Make a slice ready under a key; at once when that key is already there. */
  encode(key: string, values: Float32Array): Promise<void>;
  /** What the model finds for clicks and a box on the slice of a key. */
  decode(key: string, prompt: SegmentPrompt): Promise<SegmentAnswer>;
  /** Let everything go: the model and what was made of slices. */
  close(): void;
}

/**
 * The folder of the build the runtime's WebAssembly file is in
 * (`scripts/runtime-assets.mjs` puts it into `public/`), from the
 * application's own address.
 */
export const SEGMENT_RUNTIME_FOLDER = 'ort/';

/** Makes the worker the model runs in; a spec gives a fake. */
export type SegmentWorkerFactory = () => Worker;

function createWorker(): Worker {
  return new Worker(new URL('./segment.worker', import.meta.url), { type: 'module' });
}

type Sent = SegmentJob extends infer Job ? (Job extends unknown ? Omit<Job, 'id'> : never) : never;

/** The engine in a worker of its own, started when the model is first loaded. */
export function workerSegmentEngine(spawn: SegmentWorkerFactory = createWorker): SegmentEngine {
  let worker: Worker | null = null;
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (reply: SegmentReply) => void; reject: (error: Error) => void }
  >();
  const fail = (message: string): void => {
    for (const one of waiting.values()) one.reject(new SegmentEngineError('failed', message));
    waiting.clear();
  };
  const ask = async (job: Sent, transfer: Transferable[] = []): Promise<SegmentReply> => {
    if (!worker) {
      worker = spawn();
      worker.addEventListener('message', (event: MessageEvent<SegmentReply>) => {
        const one = waiting.get(event.data.id);
        waiting.delete(event.data.id);
        one?.resolve(event.data);
      });
      worker.addEventListener('error', (event: ErrorEvent) =>
        fail(event.message || 'The model could not be run.'),
      );
    }
    const id = next++;
    const reply = await new Promise<SegmentReply>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker!.postMessage({ ...job, id } as SegmentJob, transfer);
    });
    if (!reply.ok) throw new SegmentEngineError(reply.reason, reply.message);
    return reply;
  };
  return {
    lacks: pageLacks,
    async load(model) {
      // The files are the page's to give again: they are copied to the worker, not handed over.
      await ask({
        kind: 'load',
        model,
        runtime: new URL(SEGMENT_RUNTIME_FOLDER, document.baseURI).href,
      });
    },
    async encode(key, values) {
      await ask({ kind: 'encode', key, values }, [values.buffer]);
    },
    async decode(key, prompt) {
      const reply = await ask({ kind: 'decode', key, prompt });
      if (!reply.ok || !reply.answer) {
        throw new SegmentEngineError('failed', 'The model gave no answer.');
      }
      return reply.answer;
    },
    close() {
      worker?.terminate();
      worker = null;
      fail('The model was let go.');
    },
  };
}

/** The files the model is, each with its size and checksum: the measured ones, but in a spec. */
export const SEGMENT_MODEL_FILES = new InjectionToken<readonly SegmentModelFile[]>(
  'SEGMENT_MODEL_FILES',
  { factory: () => SEGMENT_MODEL.files },
);

/** The engine the tool uses. */
export const SEGMENT_ENGINE = new InjectionToken<SegmentEngine>('SEGMENT_ENGINE', {
  factory: () => workerSegmentEngine(),
});
