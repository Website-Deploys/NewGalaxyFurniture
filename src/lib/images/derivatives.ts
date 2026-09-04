/**
 * Derivative generation: once, at upload time, into R2.
 *
 * Generating on upload rather than on request is the central tradeoff the design makes here.
 * It costs the operator a few seconds of background work per photograph and buys every
 * visitor a pure R2 read behind an immutable cache header — no transform on the critical
 * path, and no dependency on the paid Cloudflare Images product.
 *
 * What gets written, per accepted image:
 *
 * - Every ladder width up to the original's intrinsic width, in AVIF (q50) and WebP, never
 *   upscaled (Requirements 15.8, 15.12).
 * - One JPEG as a universal fallback, at 1280 when the original reaches it.
 * - A 24 px WebP LQIP, base64-inlined into the product JSON rather than stored as an object,
 *   so a card never issues a request to avoid painting empty (Requirement 15.11).
 *
 * `generateDerivatives` reports what it wrote and what failed instead of throwing. A partial
 * result is useful — the widths that exist can serve — and the record's `derivativeWidths`
 * and `derivativeFormats` describe reality, so `srcset` never advertises an object that is
 * not there. `derivativesReady` is set only when the full plan succeeded.
 *
 * Design: Image Pipeline → Derivative generation and delivery.
 * Requirements: 15.8, 15.9, 15.10, 15.11, 15.12, 15.13.
 */

import type { R2Bucket } from '@cloudflare/workers-types';

import { derivativeKey, derivativeWidthsFor, jpegFallbackWidthFor } from './srcset';
import { putImageObject } from './store';
import { QUALITY, type ImageCodec, type RawImage } from './codec';
import type { DerivativeFormatValue } from '@/schemas/product';

/** The LQIP's width. Small enough to inline, wide enough to suggest the composition. */
export const LQIP_WIDTH = 24;

export interface DerivativePlanEntry {
  width: number;
  format: DerivativeFormatValue;
  key: string;
}

const CONTENT_TYPES: Record<DerivativeFormatValue, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

/**
 * What will be written for one image.
 *
 * `formats` is the codec's *actual* capability, not a wish list: a codec instance without an
 * AVIF encoder plans no AVIF entries, so the plan and the stored objects agree.
 */
export function planDerivatives(
  productId: string,
  imageId: string,
  intrinsicWidth: number,
  formats: readonly DerivativeFormatValue[],
): DerivativePlanEntry[] {
  const widths = derivativeWidthsFor(intrinsicWidth);
  const plan: DerivativePlanEntry[] = [];

  for (const format of ['avif', 'webp'] as const) {
    if (!formats.includes(format)) continue;
    for (const width of widths) {
      plan.push({ width, format, key: derivativeKey(productId, imageId, width, format) });
    }
  }

  if (formats.includes('jpeg')) {
    const width = jpegFallbackWidthFor(intrinsicWidth);
    plan.push({ width, format: 'jpeg', key: derivativeKey(productId, imageId, width, 'jpeg') });
  }

  return plan;
}

export interface GenerateInput {
  bucket: R2Bucket;
  codec: ImageCodec;
  /** Decoded pixels of the original — metadata already gone by construction. */
  raw: RawImage;
  productId: string;
  imageId: string;
}

export interface GenerateResult {
  written: DerivativePlanEntry[];
  failed: { key: string; reason: string }[];
  widths: number[];
  formats: DerivativeFormatValue[];
  /** True only when every planned object was written. */
  complete: boolean;
}

/** Proportional height for a target width, never zero. */
export function scaledHeight(raw: RawImage, width: number): number {
  return Math.max(1, Math.round((raw.height * width) / raw.width));
}

/**
 * Encode and store the plan.
 *
 * Resizing is done once per width and shared by the formats at that width — AVIF encoding
 * dominates the cost, and resampling the same image twice per width would add a third to
 * the total for nothing.
 */
export async function generateDerivatives(input: GenerateInput): Promise<GenerateResult> {
  const { bucket, codec, raw, productId, imageId } = input;
  const plan = planDerivatives(productId, imageId, raw.width, codec.formats);

  const written: DerivativePlanEntry[] = [];
  const failed: { key: string; reason: string }[] = [];

  const byWidth = new Map<number, DerivativePlanEntry[]>();
  for (const entry of plan) {
    const bucketForWidth = byWidth.get(entry.width);
    if (bucketForWidth === undefined) byWidth.set(entry.width, [entry]);
    else bucketForWidth.push(entry);
  }

  for (const [width, entries] of [...byWidth.entries()].sort((a, b) => a[0] - b[0])) {
    let resized: RawImage;
    try {
      resized =
        width === raw.width ? raw : await codec.resize(raw, width, scaledHeight(raw, width));
    } catch (error) {
      for (const entry of entries)
        failed.push({ key: entry.key, reason: `resize: ${String(error)}` });
      continue;
    }

    for (const entry of entries) {
      try {
        const bytes = await codec.encode(resized, entry.format, QUALITY[entry.format]);
        await putImageObject(bucket, {
          key: entry.key,
          bytes,
          contentType: CONTENT_TYPES[entry.format],
        });
        written.push(entry);
      } catch (error) {
        // Recorded, never thrown: the widths that did encode are still worth serving.
        failed.push({ key: entry.key, reason: String(error) });
      }
    }
  }

  const widths = [...new Set(written.map((entry) => entry.width))].sort((a, b) => a - b);
  const formats = (['avif', 'webp', 'jpeg'] as const).filter((format) =>
    written.some((entry) => entry.format === format),
  );

  return {
    written,
    failed,
    widths,
    formats: [...formats],
    complete: failed.length === 0 && written.length === plan.length && plan.length > 0,
  };
}

/**
 * The 24 px WebP LQIP as a data URL.
 *
 * Inlined into the product JSON rather than stored as an object: at this size the base64 is
 * smaller than the HTTP headers a request for it would carry, and inlining is what lets the
 * placeholder paint in the same frame as the HTML.
 */
export async function buildLqip(codec: ImageCodec, raw: RawImage): Promise<string | null> {
  try {
    const width = Math.min(LQIP_WIDTH, raw.width);
    const small = await codec.resize(raw, width, scaledHeight(raw, width));
    const bytes = await codec.encode(small, 'webp', QUALITY.webp);
    return `data:image/webp;base64,${base64(bytes)}`;
  } catch {
    // A missing LQIP degrades to the designed placeholder tile, which is a visual
    // difference and not a failure — never a reason to reject an accepted upload.
    return null;
  }
}

/** Bytes → base64 without Node's Buffer, which the Worker does not have by default. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The sanitized original: re-encoded from decoded pixels, so no container metadata survives.
 *
 * This is what Requirement 15.6 actually needs. Storing the uploaded bytes would keep EXIF
 * GPS, colour-profile payloads, and anything appended after the image data; storing the
 * result of a decode/encode round trip cannot, because the input to the encoder is a pixel
 * buffer.
 *
 * AVIF input is stored as WebP: re-encoding a full-size original to AVIF costs seconds of
 * CPU for an object that only ever serves as the pre-derivative fallback. The record's
 * `mime` is what the delivery route reads, so the substitution is explicit rather than
 * implied by an extension.
 */
export async function sanitizeOriginal(
  codec: ImageCodec,
  raw: RawImage,
  format: 'jpeg' | 'png' | 'webp' | 'avif',
): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  if (format === 'jpeg') {
    return { bytes: await codec.encode(raw, 'jpeg', 92), mime: 'image/jpeg', ext: 'jpg' };
  }
  return { bytes: await codec.encode(raw, 'webp', QUALITY.webp), mime: 'image/webp', ext: 'webp' };
}
