/**
 * Real image bytes and the real codec, for the image-pipeline suites.
 *
 * Two decisions worth stating:
 *
 * 1. **The codec is the production codec.** `photonApiFrom` and `avifApiFrom` are the same
 *    adapters `src/lib/images/codec-photon.ts` uses in the Worker; only the module resolution
 *    differs (`@cf-wasm/photon/node` and `.wasm` compiled from disk, because Node cannot import
 *    a `.wasm` file as a module the way the Cloudflare build can). So a passing derivative test
 *    is evidence about the encoder that ships, not about a stub.
 * 2. **The test images are generated, not committed.** A PNG is built here byte by byte — IHDR,
 *    a deflated IDAT, IEND — so the suite has valid images at any size it needs without adding
 *    binaries to the repository, and the "not an image" cases can be assembled from real
 *    signatures rather than approximated.
 */

import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as photonNode from '@cf-wasm/photon/node';
import encodeAvif, { init as initAvifEncoder } from '@jsquash/avif/encode.js';
import decodeAvif, { init as initAvifDecoder } from '@jsquash/avif/decode.js';

import {
  avifApiFrom,
  photonApiFrom,
  type AvifLib,
  type PhotonLib,
} from '@/lib/images/codec-adapters';
import { createCodec, type ImageCodec } from '@/lib/images/codec';

/* -------------------------------------------------------------------------- */
/* Synthetic images                                                           */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid 8-bit RGBA PNG with a deterministic gradient. */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 4] = Math.floor((x * 255) / Math.max(1, width));
      row[2 + x * 4] = Math.floor((y * 255) / Math.max(1, height));
      row[3 + x * 4] = 160;
      row[4 + x * 4] = 255;
    }
    rows.push(row);
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', new Uint8Array()),
    ]),
  );
}

/** Raw RGBA pixels, for encoder tests that need no container. */
export function makeRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = i % 251;
    rgba[i * 4 + 1] = 90;
    rgba[i * 4 + 2] = 180;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** A `File`-like upload candidate over fixed bytes. */
export function fileFrom(
  name: string,
  type: string,
  bytes: Uint8Array,
): { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> } {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

/* -------------------------------------------------------------------------- */
/* The codec                                                                  */
/* -------------------------------------------------------------------------- */

function wasmPath(relative: string): string {
  return fileURLToPath(new URL(`../../node_modules/${relative}`, import.meta.url));
}

let cached: ImageCodec | null = null;

/**
 * The production codec, resolved for Node.
 *
 * Cached because compiling 4.6 MB of WebAssembly per test file is the slowest thing in the
 * suite by an order of magnitude.
 */
export async function nodeCodec(): Promise<ImageCodec> {
  if (cached !== null) return cached;

  const avifLib: AvifLib = {
    initEncode: (module) => initAvifEncoder(module),
    encode: (image, options) => encodeAvif(image as unknown as ImageData, options),
    initDecode: (module) => initAvifDecoder(module),
    decode: async (bytes) => await decodeAvif(bytes),
  };

  const [encoderModule, decoderModule] = await Promise.all([
    WebAssembly.compile(readFileSync(wasmPath('@jsquash/avif/codec/enc/avif_enc.wasm'))),
    WebAssembly.compile(readFileSync(wasmPath('@jsquash/avif/codec/dec/avif_dec.wasm'))),
  ]);

  cached = createCodec(
    photonApiFrom(photonNode as unknown as PhotonLib),
    avifApiFrom(avifLib, encoderModule, decoderModule),
  );
  return cached;
}

/** A codec with no AVIF support, for the "plans only what it can write" case. */
export function nodeCodecWithoutAvif(): ImageCodec {
  return createCodec(photonApiFrom(photonNode as unknown as PhotonLib));
}
