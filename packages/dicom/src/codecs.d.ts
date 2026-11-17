/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Ambient declarations for the @cornerstonejs/codec-* wasm packages, which ship
// no TypeScript types. Each is an Emscripten MODULARIZE build whose default
// export is a factory returning a ready module with embind-bound decoder
// classes. We type only the decoder surface this project uses.

/** Frame geometry reported by a decoder after {@link CodecDecoder.decode}. */
interface CodecFrameInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number;
  readonly componentCount: number;
}

/** A single-frame decoder instance (JPEG / JPEG-LS / JPEG 2000). */
interface CodecDecoder {
  /** Allocate `size` bytes in the wasm heap and return a view to fill. */
  getEncodedBuffer(size: number): Uint8Array;
  /** The decoded raw samples (view into the wasm heap; copy before reuse). */
  getDecodedBuffer(): Uint8Array;
  getFrameInfo(): CodecFrameInfo;
  decode(): void;
  delete(): void;
}

/** The ready Emscripten module, keyed by embind class name. */
interface CodecModule {
  readonly [decoderClass: string]: new () => CodecDecoder;
}

/** Emscripten MODULARIZE factory. */
type CodecModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<CodecModule>;

declare module '@cornerstonejs/codec-libjpeg-turbo-8bit' {
  const factory: CodecModuleFactory;
  export default factory;
}

declare module '@cornerstonejs/codec-charls' {
  const factory: CodecModuleFactory;
  export default factory;
}

declare module '@cornerstonejs/codec-openjpeg' {
  const factory: CodecModuleFactory;
  export default factory;
}

// jpeg-lossless-decoder-js names a declaration file its package does not hold.
declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    /** Lines decoded so far: the frame's rows when the whole image was. */
    yLoc: number;
    /** Pixels decoded so far of the line it is on. */
    xLoc: number;
    /** What it reads from; `index` is how many bytes it has asked for. */
    stream: { index: number } | null;
    /**
     * Decode `length` bytes of `buffer` from `offset`. `numBytes` is the bytes
     * an output sample takes, 1 or 2.
     */
    decode(
      buffer: ArrayBuffer,
      offset: number,
      length: number,
      numBytes?: number,
    ): Uint8Array | Uint16Array;
  }
}
