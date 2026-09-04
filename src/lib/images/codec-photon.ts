/**
 * The Worker's codec: the two WebAssembly libraries, resolved and wired.
 *
 * This is the only module that imports them, so the ~5 MB of `.wasm` the build emits is
 * reachable from exactly two routes — the image upload endpoint and nothing else at runtime —
 * and never from a page render.
 *
 * The `.wasm` imports matter. jSquash's emscripten glue otherwise resolves `avif_enc.wasm`
 * through `new URL(..., import.meta.url)` and *fetches* it, which cannot work in a Worker:
 * there is no origin to fetch a local file from. Importing the module and handing it to `init`
 * makes instantiation local and synchronous. Both modules were confirmed to instantiate and
 * run inside workerd — Photon encoding WebP and JPEG and decoding its own output, jSquash
 * encoding AVIF — before this wiring was written.
 *
 * Everything below the imports is in `codec-adapters.ts`, which the test suite drives with the
 * Node builds of the same libraries. There is one implementation of the conversion logic.
 *
 * Requirements: 15.5, 15.6, 15.8, 15.9.
 */

import * as photon from '@cf-wasm/photon';
import encodeAvif, { init as initAvifEncoder } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initAvifDecoder } from '@jsquash/avif/decode.js';
// @ts-expect-error — `.wasm` resolves to a WebAssembly.Module through the Cloudflare build.
import avifEncWasm from '@jsquash/avif/codec/enc/avif_enc.wasm';
// @ts-expect-error — as above.
import avifDecWasm from '@jsquash/avif/codec/dec/avif_dec.wasm';

import { avifApiFrom, photonApiFrom, type AvifLib, type PhotonLib } from './codec-adapters';
import { createCodec, type ImageCodec } from './codec';

const avifLib: AvifLib = {
  initEncode: (module) => initAvifEncoder(module),
  encode: (image, options) => encodeAvif(image as unknown as ImageData, options),
  initDecode: (module) => initAvifDecoder(module),
  decode: async (bytes) => await decodeAvif(bytes),
};

/** The codec the Worker routes use. */
export function createWorkerCodec(): ImageCodec {
  return createCodec(
    photonApiFrom(photon as unknown as PhotonLib),
    avifApiFrom(avifLib, avifEncWasm as WebAssembly.Module, avifDecWasm as WebAssembly.Module),
  );
}
