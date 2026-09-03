/**
 * Adapters from the two WebAssembly libraries to this project's codec interface.
 *
 * Deliberately free of `import` statements for either library: the libraries are *passed in*.
 * That is what lets the Worker resolve `@cf-wasm/photon`'s `workerd` build and its bundled
 * `.wasm` assets, while the test suite resolves the `node` build and compiles the same `.wasm`
 * files from disk — with **one** implementation of the adapter logic in between. Duplicating
 * these thirty lines into a test helper would mean the suite exercised a copy of the
 * conversion code rather than the code that runs in production, which is precisely the kind of
 * test that passes while the real path is broken.
 *
 * Requirements: 15.5, 15.8, 15.9.
 */

import type { AvifApi, PhotonApi, PhotonImageLike, RawImage } from './codec';

/** The parts of `@cf-wasm/photon`'s module namespace that are used. */
export interface PhotonLib {
  PhotonImage: PhotonApi['PhotonImage'];
  resize: (
    image: PhotonImageLike,
    width: number,
    height: number,
    filter: number,
  ) => PhotonImageLike;
  SamplingFilter: { Lanczos3: number };
}

export function photonApiFrom(lib: PhotonLib): PhotonApi {
  return {
    PhotonImage: lib.PhotonImage,
    resize: lib.resize,
    lanczos3: lib.SamplingFilter.Lanczos3,
  };
}

/** What jSquash's AVIF encode/decode entry points look like, structurally. */
export interface AvifLib {
  initEncode: (module: WebAssembly.Module) => Promise<unknown>;
  encode: (
    image: { data: Uint8ClampedArray; width: number; height: number },
    options: { quality: number; speed: number },
  ) => Promise<ArrayBuffer>;
  initDecode: (module: WebAssembly.Module) => Promise<unknown>;
  decode: (
    bytes: ArrayBuffer,
  ) => Promise<{ data: Uint8ClampedArray; width: number; height: number } | null>;
}

/**
 * Wire the AVIF library to the codec.
 *
 * `init` is called before every operation rather than once behind a flag. It is idempotent and
 * cheap after the first call, and an isolate that is reused across requests would otherwise
 * depend on module-level mutable state being correct — which is a harder thing to be sure of
 * than a repeated no-op.
 */
export function avifApiFrom(
  lib: AvifLib,
  encoderModule: WebAssembly.Module,
  decoderModule: WebAssembly.Module,
): AvifApi {
  return {
    async encode(image: RawImage, quality: number): Promise<Uint8Array> {
      await lib.initEncode(encoderModule);
      const encoded = await lib.encode(
        { data: new Uint8ClampedArray(image.rgba), width: image.width, height: image.height },
        // Speed 8 of 10: AVIF at the slowest settings costs seconds per width for a few
        // percent of file size, and this work happens while an operator waits to see
        // "optimizing" clear.
        { quality, speed: 8 },
      );
      return new Uint8Array(encoded);
    },

    async decode(bytes: Uint8Array): Promise<RawImage | null> {
      await lib.initDecode(decoderModule);
      // `slice()` rather than a view: the decoder is handed a buffer whose bytes are exactly
      // the file's, and a subarray would expose the whole backing allocation.
      const copy = bytes.slice();
      const decoded = await lib.decode(copy.buffer);
      if (decoded === null || decoded === undefined) return null;
      return {
        width: decoded.width,
        height: decoded.height,
        rgba: new Uint8Array(decoded.data.buffer),
      };
    },
  };
}
