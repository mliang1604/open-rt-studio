/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the click-to-segment tool (#340) and its model agree on, with no
// model in it: which files the model is, how a slice is made into what the
// model takes, how clicks and a box are given to it, and how its answer
// becomes a mask of the slice. The arrangement is the spike's (#121,
// docs/click-to-segment.md): SAM 2.1 tiny at half precision, as two
// networks. The encoder runs once for a slice and the window it is shown
// through; the decoder runs for every click.
//
// The model's files are not in the repository and are not ours: they are
// Apache 2.0, from `onnx-community/sam2.1-hiera-tiny-ONNX`. A file is taken
// only when it is byte for byte the one that was measured.

/** The side of the square picture the model takes, in pixels. */
export const SEGMENT_SIDE = 1024;

/** What the model was trained to expect of a picture's three colours. */
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** One file of the model. */
export interface SegmentModelFile {
  /** What the tool calls it. */
  readonly part: 'encoder' | 'encoderData' | 'decoder' | 'decoderData';
  /** Its name where it is published. */
  readonly name: string;
  readonly bytes: number;
  /** SHA-256 of its bytes, in hexadecimal. */
  readonly sha256: string;
}

/** The model the tool runs: its name, where it is published, and its files. */
export const SEGMENT_MODEL = {
  title: 'SAM 2.1 tiny, half precision',
  source: 'onnx-community/sam2.1-hiera-tiny-ONNX',
  licence: 'Apache 2.0',
  files: [
    {
      part: 'encoder',
      name: 'vision_encoder_fp16.onnx',
      bytes: 314_925,
      sha256: '7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a',
    },
    {
      part: 'encoderData',
      name: 'vision_encoder_fp16.onnx_data',
      bytes: 67_005_504,
      sha256: 'a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e',
    },
    {
      part: 'decoder',
      name: 'prompt_encoder_mask_decoder_fp16.onnx',
      bytes: 229_799,
      sha256: '00ac7200451f246e8307aa1a1648113f47dc45625738406403a0e6b86c69fc55',
    },
    {
      part: 'decoderData',
      name: 'prompt_encoder_mask_decoder_fp16.onnx_data',
      bytes: 10_454_016,
      sha256: '027b457a53f5bd76bb401c59555448451d04b4eab6d2f6a6758406b40133ee2c',
    },
  ] as readonly SegmentModelFile[],
} as const;

/** The model's files as bytes, by part. */
export type SegmentModelBytes = Readonly<Record<SegmentModelFile['part'], ArrayBuffer>>;

/** Why files that were chosen are not the model. */
export type SegmentFilesProblem =
  | { readonly kind: 'missing'; readonly names: readonly string[] }
  | { readonly kind: 'wrong'; readonly name: string };

/** What a chosen file has to offer: a name, a size and its bytes. */
export interface ChosenFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** SHA-256 of bytes, in hexadecimal. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The model's files from what was chosen, each found by its name and held
 * to its size and checksum; or why they are not the model. Files that are
 * no part of the model are passed over.
 */
export async function modelFrom(
  chosen: readonly ChosenFile[],
  files: readonly SegmentModelFile[] = SEGMENT_MODEL.files,
  digest: (bytes: ArrayBuffer) => Promise<string> = sha256Hex,
): Promise<SegmentModelBytes | SegmentFilesProblem> {
  const missing = files.filter((file) => !chosen.some((one) => one.name === file.name));
  if (missing.length > 0) return { kind: 'missing', names: missing.map((file) => file.name) };
  const parts: Partial<Record<SegmentModelFile['part'], ArrayBuffer>> = {};
  for (const file of files) {
    const one = chosen.find((candidate) => candidate.name === file.name)!;
    if (one.size !== file.bytes) return { kind: 'wrong', name: file.name };
    const bytes = await one.arrayBuffer();
    if ((await digest(bytes)) !== file.sha256) return { kind: 'wrong', name: file.name };
    parts[file.part] = bytes;
  }
  return parts as SegmentModelBytes;
}

/**
 * A slice as the model takes it: shown through a window as grey from 0 to
 * 1, stretched to 1024 pixels a side (each way by itself, as the model's
 * own preparation does), the same grey as each of three colours, and each
 * colour brought to what the model expects. Three planes of 1024 × 1024.
 */
export function pixelValues(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  low: number,
  high: number,
): Float32Array {
  const side = SEGMENT_SIDE;
  const range = high > low ? high - low : 1;
  const grey = (value: number): number => Math.min(1, Math.max(0, (value - low) / range));
  const [scaleX, scaleY] = [width / side, height / side];
  const stretched = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < side; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      stretched[y * side + x] =
        (grey(plane[y0 * width + x0]) * (1 - wx) + grey(plane[y0 * width + x1]) * wx) * (1 - wy) +
        (grey(plane[y1 * width + x0]) * (1 - wx) + grey(plane[y1 * width + x1]) * wx) * wy;
    }
  }
  const values = new Float32Array(3 * side * side);
  for (let colour = 0; colour < 3; colour++) {
    const into = values.subarray(colour * side * side, (colour + 1) * side * side);
    for (let i = 0; i < stretched.length; i++) {
      into[i] = (stretched[i] - MEAN[colour]) / STD[colour];
    }
  }
  return values;
}

/** A click on a slice, in its pixels: on the object, or on what is not the object. */
export interface SegmentClick {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

/** A box about the object on a slice, in its pixels. */
export interface SegmentBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** What the decoder is asked: clicks and a box, in the model's own picture. */
export interface SegmentPrompt {
  /** x and y of each click, one after another. */
  readonly points: Float32Array;
  /** 1 for a click on the object, 0 for one off it, -1 for none (a box alone). */
  readonly labels: readonly number[];
  /** x0, y0, x1, y1; null for no box. */
  readonly box: Float32Array | null;
}

/**
 * Clicks and a box on a slice of `width` × `height` pixels as the model
 * takes them. A box alone still needs a point, which says that it is none.
 */
export function promptOf(
  clicks: readonly SegmentClick[],
  box: SegmentBox | null,
  width: number,
  height: number,
): SegmentPrompt {
  const toX = (x: number): number => ((x + 0.5) * SEGMENT_SIDE) / width;
  const toY = (y: number): number => ((y + 0.5) * SEGMENT_SIDE) / height;
  const points =
    clicks.length > 0
      ? Float32Array.from(clicks.flatMap((click) => [toX(click.x), toY(click.y)]))
      : new Float32Array(2);
  const labels = clicks.length > 0 ? clicks.map((click) => (click.on ? 1 : 0)) : [-1];
  return {
    points,
    labels,
    box: box
      ? Float32Array.of(
          toX(Math.min(box.x0, box.x1)),
          toY(Math.min(box.y0, box.y1)),
          toX(Math.max(box.x0, box.x1)),
          toY(Math.max(box.y0, box.y1)),
        )
      : null,
  };
}

/** What the decoder answers: several masks as numbers above 0 inside the object, and how sure it is of each. */
export interface SegmentAnswer {
  /** `count` masks of `side` × `side` numbers, one after another. */
  readonly logits: Float32Array;
  readonly side: number;
  readonly scores: readonly number[];
}

/**
 * One mask of an answer as a mask of the slice: stretched back to `width`
 * × `height` pixels, a pixel being in it where the model's number is above
 * 0.
 */
export function maskOf(
  answer: SegmentAnswer,
  which: number,
  width: number,
  height: number,
): Uint8Array {
  const from = answer.side;
  const logits = answer.logits.subarray(which * from * from, (which + 1) * from * from);
  const mask = new Uint8Array(width * height);
  const [scaleX, scaleY] = [from / width, from / height];
  for (let y = 0; y < height; y++) {
    const fy = Math.min(from - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(from - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(from - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(from - 1, x0 + 1);
      const wx = fx - x0;
      const value =
        (logits[y0 * from + x0] * (1 - wx) + logits[y0 * from + x1] * wx) * (1 - wy) +
        (logits[y1 * from + x0] * (1 - wx) + logits[y1 * from + x1] * wx) * wy;
      if (value > 0) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** The masks of an answer in the order they are offered: the one the model is surest of first. */
export function masksInOrder(answer: SegmentAnswer): number[] {
  return answer.scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((one) => one.index);
}
