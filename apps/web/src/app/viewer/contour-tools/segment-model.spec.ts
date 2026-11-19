/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  SEGMENT_MODEL,
  SEGMENT_SIDE,
  maskOf,
  masksInOrder,
  modelFrom,
  pixelValues,
  promptOf,
  sha256Hex,
  type ChosenFile,
  type SegmentModelFile,
} from './segment-model';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const fileOf = (name: string, text: string): ChosenFile => ({
  name,
  size: bytesOf(text).byteLength,
  arrayBuffer: async () => bytesOf(text),
});

describe('the click-to-segment model’s files (#340)', () => {
  it('are four, 78 MB together, each with a checksum', () => {
    expect(SEGMENT_MODEL.files.map((file) => file.part)).toEqual([
      'encoder',
      'encoderData',
      'decoder',
      'decoderData',
    ]);
    const total = SEGMENT_MODEL.files.reduce((sum, file) => sum + file.bytes, 0);
    expect(Math.round(total / 1e6)).toBe(78);
    for (const file of SEGMENT_MODEL.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('are taken only when each is there, of its size and of its checksum', async () => {
    const files: SegmentModelFile[] = [];
    for (const [part, name, text] of [
      ['encoder', 'e.onnx', 'the encoder'],
      ['encoderData', 'e.onnx_data', 'its numbers'],
      ['decoder', 'd.onnx', 'the decoder'],
      ['decoderData', 'd.onnx_data', 'its own'],
    ] as const) {
      files.push({
        part,
        name,
        bytes: bytesOf(text).byteLength,
        sha256: await sha256Hex(bytesOf(text)),
      });
    }
    const chosen = [
      fileOf('e.onnx', 'the encoder'),
      fileOf('e.onnx_data', 'its numbers'),
      fileOf('d.onnx', 'the decoder'),
      fileOf('d.onnx_data', 'its own'),
      fileOf('README.md', 'something else, passed over'),
    ];
    const taken = await modelFrom(chosen, files);
    expect('kind' in taken).toBe(false);
    expect(new TextDecoder().decode((taken as { decoder: ArrayBuffer }).decoder)).toBe(
      'the decoder',
    );

    expect(await modelFrom(chosen.slice(0, 2), files)).toEqual({
      kind: 'missing',
      names: ['d.onnx', 'd.onnx_data'],
    });
    // Another size, and the same size with other bytes.
    expect(await modelFrom([...chosen.slice(1), fileOf('e.onnx', 'an encoder')], files)).toEqual({
      kind: 'wrong',
      name: 'e.onnx',
    });
    expect(await modelFrom([...chosen.slice(1), fileOf('e.onnx', 'the encodeR')], files)).toEqual({
      kind: 'wrong',
      name: 'e.onnx',
    });
  });

  it('checksums as SHA-256 does', async () => {
    expect(await sha256Hex(bytesOf('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('a slice as the model takes it (#340)', () => {
  it('is shown through the window, stretched to the model’s square and made three colours', () => {
    // Two columns: below the window, and above it. Twice as wide as high.
    const values = pixelValues([-500, 500], 2, 1, -100, 100);
    expect(values.length).toBe(3 * SEGMENT_SIDE * SEGMENT_SIDE);
    const plane = SEGMENT_SIDE * SEGMENT_SIDE;
    const at = (colour: number, x: number, y: number): number =>
      values[colour * plane + y * SEGMENT_SIDE + x];
    // Black on the left, white on the right, the same down every column.
    expect(at(0, 0, 0)).toBeCloseTo((0 - 0.485) / 0.229, 5);
    expect(at(0, SEGMENT_SIDE - 1, SEGMENT_SIDE - 1)).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(at(1, 0, 500)).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(at(2, SEGMENT_SIDE - 1, 500)).toBeCloseTo((1 - 0.406) / 0.225, 5);
    // Between the two columns' middles it runs from one to the other.
    const middle = at(0, SEGMENT_SIDE / 2, 0) * 0.229 + 0.485;
    expect(middle).toBeGreaterThan(0.45);
    expect(middle).toBeLessThan(0.55);
  });

  it('is grey between the window’s ends', () => {
    const values = pixelValues([0], 1, 1, -100, 300);
    expect(values[0] * 0.229 + 0.485).toBeCloseTo(0.25, 5);
  });
});

describe('what the model is asked, and what it answers (#340)', () => {
  it('takes clicks and a box in its own square, each way by itself', () => {
    const prompt = promptOf(
      [
        { x: 0, y: 0, on: true },
        { x: 3, y: 1, on: false },
      ],
      { x0: 3, y0: 1, x1: 1, y1: 0 },
      4,
      2,
    );
    // The middle of pixel 0 of 4 is an eighth of the way across; of 2, a quarter.
    expect(Array.from(prompt.points)).toEqual([128, 256, 896, 768]);
    expect(prompt.labels).toEqual([1, 0]);
    // A box from its lower corner to its higher, whichever way it was dragged.
    expect(Array.from(prompt.box!)).toEqual([384, 256, 896, 768]);
  });

  it('gives a box alone a point that says it is none', () => {
    const prompt = promptOf([], { x0: 0, y0: 0, x1: 1, y1: 1 }, 2, 2);
    expect(prompt.labels).toEqual([-1]);
    expect(prompt.points.length).toBe(2);
    expect(promptOf([{ x: 0, y: 0, on: true }], null, 2, 2).box).toBeNull();
  });

  it('makes a mask of the slice from the model’s numbers: in where they are above 0', () => {
    // Two masks of 2 × 2: the left column, and the top row.
    const answer = {
      logits: Float32Array.of(5, -5, 5, -5, 5, 5, -5, -5),
      side: 2,
      scores: [0.2, 0.9],
    };
    // Stretched to 4 wide and 2 high: the left half, and the top row.
    expect(Array.from(maskOf(answer, 0, 4, 2))).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    expect(Array.from(maskOf(answer, 1, 4, 2))).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it('offers the masks the surest first', () => {
    expect(masksInOrder({ logits: new Float32Array(0), side: 0, scores: [0.2, 0.9, 0.5] })).toEqual(
      [1, 2, 0],
    );
  });
});
