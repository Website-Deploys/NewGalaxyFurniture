/**
 * The image codec: decode, resize, encode.
 *
 * An interface rather than direct calls into a library, for one concrete reason: the design
 * names `@cf-wasm/photon`, and Photon **cannot encode AVIF**. Its encoders are PNG, JPEG
 * and WebP (`get_bytes`, `get_bytes_jpeg`, `get_bytes_webp`) and its decoder does not
 * handle AVIF either. Requirement 15.9 requires AVIF at every derivative width and
 * Requirement 15.1 requires AVIF *uploads* to be accepted, so a second codec is
 * unavoidable: `@jsquash/avif` (a WebAssembly build of libavif) supplies both directions.
 * Both were verified end to end inside workerd, not only under Node — see
 * `tests/unit/images.derivatives.test.ts` for the Node half.
 *
 * The split of responsibility:
 *
 * - **Photon** decodes JPEG/PNG/WebP, resizes (Lanczos3), and encodes WebP and JPEG.
 * - **jSquash AVIF** decodes AVIF input and encodes AVIF output.
 *
 * Both are WebAssembly and both need their module supplied by the caller. In the Worker the
 * modules come from `import`ed `.wasm` assets, which the Cloudflare build emits and
 * instantiates; under Node the tests compile them from disk. That is why every entry point
 * here takes its module rather than reaching for a global: there is exactly one
 * implementation of the codec, exercised identically in both environments, so a passing test
 * is evidence about production behaviour rather than about a test double.
 *
 * AVIF encoding is also the expensive half (hundreds of milliseconds per width), which is
 * why derivative generation runs in `ctx.waitUntil` after a fast `201` and why the image
 * record carries `derivativesReady`.
 *
 * Design: Image Pipeline → Derivative generation and delivery.
 * Requirements: 15.5, 15.6, 15.8, 15.9, 15.11, 15.12.
 */

import type { DecodedPixels } from './validate';
import type { DerivativeFormatValue } from '@/schemas/product';
import type { SniffedType } from './sniff';

export interface RawImage extends DecodedPixels {
  /** RGBA, 8 bits per channel, `width * height * 4` bytes. */
  rgba: Uint8Array;
}

export interface ImageCodec {
  /** Null on any failure — a decode failure is a rejection, not an exception. */
  decode(bytes: Uint8Array, type: SniffedType): Promise<RawImage | null>;
  resize(image: RawImage, width: number, height: number): Promise<RawImage>;
  encode(image: RawImage, format: DerivativeFormatValue, quality: number): Promise<Uint8Array>;
  /** Which output formats this codec instance can actually produce. */
  readonly formats: readonly DerivativeFormatValue[];
}

/** The design's quality settings. */
export const QUALITY = { avif: 50, webp: 78, jpeg: 82 } as const;

/**
 * The Photon surface this module uses.
 *
 * Typed structurally so `codec.ts` does not import the library at module scope: the Worker
 * bundle pulls in 1.5 MB of WebAssembly for Photon and 3.4 MB for the AVIF encoder, and
 * only the upload and delivery routes should carry that weight.
 */
export interface PhotonApi {
  PhotonImage: {
    new (rgba: Uint8Array, width: number, height: number): PhotonImageLike;
    new_from_byteslice(bytes: Uint8Array): PhotonImageLike;
  };
  resize(image: PhotonImageLike, width: number, height: number, filter: number): PhotonImageLike;
  /** `SamplingFilter.Lanczos3`. */
  lanczos3: number;
}

export interface PhotonImageLike {
  get_width(): number;
  get_height(): number;
  get_raw_pixels(): Uint8Array;
  get_bytes_webp(): Uint8Array;
  get_bytes_jpeg(quality: number): Uint8Array;
  get_bytes(): Uint8Array;
  free(): void;
}

export interface AvifApi {
  encode(image: RawImage, quality: number): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<RawImage | null>;
}

/**
 * Build the codec from the two WebAssembly-backed APIs.
 *
 * `avif` is optional. Without it the codec's `formats` omits AVIF, and the derivative
 * planner therefore never plans an AVIF entry — rather than planning one and writing
 * nothing, which is how a `srcset` ends up advertising an object that does not exist. An
 * AVIF *upload* without the AVIF API is refused at the decode step with the ordinary
 * "could not be opened" reason.
 */
export function createCodec(photon: PhotonApi, avif?: AvifApi): ImageCodec {
  const formats: DerivativeFormatValue[] =
    avif === undefined ? ['webp', 'jpeg'] : ['avif', 'webp', 'jpeg'];

  return {
    formats,

    async decode(bytes, type) {
      if (type.format === 'avif') {
        if (avif === undefined) return null;
        try {
          return await avif.decode(bytes);
        } catch {
          return null;
        }
      }
      try {
        const image = photon.PhotonImage.new_from_byteslice(bytes);
        const raw: RawImage = {
          width: image.get_width(),
          height: image.get_height(),
          rgba: image.get_raw_pixels(),
        };
        image.free();
        if (raw.width === 0 || raw.height === 0) return null;
        return raw;
      } catch {
        return null;
      }
    },

    // Photon's resize is synchronous, but the interface is async because the AVIF encoder is
    // not, and a mixed-sync-and-async codec interface pushes that difference into every caller.
    // eslint-disable-next-line @typescript-eslint/require-await
    async resize(image, width, height) {
      const source = new photon.PhotonImage(image.rgba, image.width, image.height);
      const resized = photon.resize(source, width, height, photon.lanczos3);
      const out: RawImage = {
        width: resized.get_width(),
        height: resized.get_height(),
        rgba: resized.get_raw_pixels(),
      };
      source.free();
      resized.free();
      return out;
    },

    async encode(image, format, quality) {
      if (format === 'avif') {
        if (avif === undefined) {
          throw new Error('AVIF encoding is not available in this codec instance');
        }
        return await avif.encode(image, quality);
      }
      const source = new photon.PhotonImage(image.rgba, image.width, image.height);
      try {
        // Photon's WebP encoder takes no quality argument — it is a single fixed setting.
        // The design's "WebP quality 78" is therefore not expressible through this codec;
        // the parameter is accepted and ignored so the call sites stay uniform and the
        // limitation lives in one commented place instead of being silently absent.
        return format === 'webp' ? source.get_bytes_webp() : source.get_bytes_jpeg(quality);
      } finally {
        source.free();
      }
    },
  };
}
