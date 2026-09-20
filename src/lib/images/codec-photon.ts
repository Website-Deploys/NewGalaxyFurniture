/**
 * The image codec for the Netlify Functions runtime: the two WebAssembly libraries, resolved and
 * wired for Node.
 *
 * This is the only module the image routes import for encoding/decoding, so the ~5 MB of `.wasm`
 * is reachable from exactly two routes — the product-image upload and the enquiry-image path — and
 * never from a page render.
 *
 * **Why WASM is read from disk here rather than imported.** On Cloudflare Workers the `.wasm`
 * files were imported as `WebAssembly.Module` by the bundler. The Netlify Functions runtime is
 * Node, where a `.wasm` import has no default export; instead the module bytes are read from
 * `node_modules` with `readFileSync` and compiled with `new WebAssembly.Module(...)`, then handed to
 * jSquash's `init`. This is the identical approach the test suite and the `product:add` CLI already
 * use for Node, so there is now one Node-shaped codec instead of a Worker one and a Node one.
 *
 * The Photon library is the `@cf-wasm/photon/node` build (a general WASM Photon distribution that
 * runs under Node — the `@cf-wasm` name is the package author's, not a Cloudflare runtime
 * dependency). The jSquash AVIF encoder/decoder WASM modules are read relative to `node_modules`.
 * The adapter's `includeFiles` bundles these files with the deployed function.
 *
 * Everything below the imports is in `codec-adapters.ts`. There is one implementation of the
 * conversion logic.
 *
 * Requirements: 15.5, 15.6, 15.8, 15.9.
 */

import { readFileSync } from 'node:fs';

import * as photon from '@cf-wasm/photon/node';
import encodeAvif, { init as initAvifEncoder } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initAvifDecoder } from '@jsquash/avif/decode.js';

import { avifApiFrom, photonApiFrom, type AvifLib, type PhotonLib } from './codec-adapters';
import { createCodec, type ImageCodec } from './codec';

/** Compile a WASM module from a path relative to `node_modules`. */
function wasmModule(relative: string): WebAssembly.Module {
  return new WebAssembly.Module(
    readFileSync(new URL(`../../../node_modules/${relative}`, import.meta.url)),
  );
}

const avifLib: AvifLib = {
  initEncode: (module) => initAvifEncoder(module),
  encode: (image, options) => encodeAvif(image as unknown as ImageData, options),
  initDecode: (module) => initAvifDecoder(module),
  decode: async (bytes) => await decodeAvif(bytes),
};

/** The codec the image routes use, wired for the Node/Netlify runtime. */
export function createWorkerCodec(): ImageCodec {
  return createCodec(
    photonApiFrom(photon as unknown as PhotonLib),
    avifApiFrom(
      avifLib,
      wasmModule('@jsquash/avif/codec/enc/avif_enc.wasm'),
      wasmModule('@jsquash/avif/codec/dec/avif_dec.wasm'),
    ),
  );
}
