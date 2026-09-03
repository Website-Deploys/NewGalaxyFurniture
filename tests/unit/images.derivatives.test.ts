import { describe, expect, it } from 'vitest';

import {
  buildLqip,
  generateDerivatives,
  planDerivatives,
  sanitizeOriginal,
  scaledHeight,
} from '@/lib/images/derivatives';
import { derivativeWidthsFor, jpegFallbackWidthFor } from '@/lib/images/srcset';
import { sniffImageType } from '@/lib/images/sniff';
import { validateUpload } from '@/lib/images/validate';
import { fileFrom, makePng, makeRgba, nodeCodec, nodeCodecWithoutAvif } from '../fixtures/images';
import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * Derivative generation against the **real** codec.
 *
 * Photon (WebP, JPEG, resize, decode) and jSquash (AVIF encode and decode) are the same
 * adapters the Worker uses; only module resolution differs. So these assertions are about the
 * encoders that ship: the bytes are checked for their format signatures rather than for a
 * length, because "something came back" is not evidence that it is an AVIF.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.8, 15.9, 15.11, 15.12.
 */

/** An in-memory stand-in for R2 with the two methods the pipeline uses. */
function memoryBucket(): {
  bucket: R2Bucket;
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket = {
    put: async (
      key: string,
      value: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      objects.set(key, {
        bytes: new Uint8Array(value),
        ...(options?.httpMetadata?.contentType === undefined
          ? {}
          : { contentType: options.httpMetadata.contentType }),
      });
      return undefined;
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

const PRODUCT_ID = 'p_abcdefghij';
const IMAGE_ID = 'img_abcdefghij';

describe('the width ladder', () => {
  it('offers the design’s widths and never one above the original', () => {
    expect(derivativeWidthsFor(2400)).toStrictEqual([320, 480, 640, 960, 1280, 1600, 2000]);
    expect(derivativeWidthsFor(1000)).toStrictEqual([320, 480, 640, 960]);
    expect(derivativeWidthsFor(800)).toStrictEqual([320, 480, 640]);
  });

  it('falls back to the image’s own width when it is narrower than the smallest rung', () => {
    // Below the 800 px upload minimum this cannot happen in practice; the ladder is still total
    // so a `srcset` can never come out empty.
    expect(derivativeWidthsFor(200)).toStrictEqual([200]);
    expect(derivativeWidthsFor(1)).toStrictEqual([1]);
  });

  it('puts the JPEG fallback at 1280, or at the widest derivative for a smaller original', () => {
    expect(jpegFallbackWidthFor(2400)).toBe(1280);
    expect(jpegFallbackWidthFor(1000)).toBe(960);
    expect(jpegFallbackWidthFor(800)).toBe(640);
  });

  it('keeps the aspect ratio and never scales to zero', () => {
    expect(scaledHeight({ width: 2000, height: 1000, rgba: new Uint8Array() }, 320)).toBe(160);
    expect(scaledHeight({ width: 4000, height: 5, rgba: new Uint8Array() }, 320)).toBe(1);
  });
});

describe('the plan describes what will actually be written', () => {
  it('covers every ladder width in AVIF and WebP, plus one JPEG', () => {
    const plan = planDerivatives(PRODUCT_ID, IMAGE_ID, 2400, ['avif', 'webp', 'jpeg']);
    const widths = derivativeWidthsFor(2400);
    expect(plan.filter((entry) => entry.format === 'avif')).toHaveLength(widths.length);
    expect(plan.filter((entry) => entry.format === 'webp')).toHaveLength(widths.length);
    expect(plan.filter((entry) => entry.format === 'jpeg')).toHaveLength(1);
    expect(plan.every((entry) => entry.width <= 2400)).toBe(true);
    expect(plan[0]?.key).toBe(`products/${PRODUCT_ID}/${IMAGE_ID}/320.avif`);
  });

  it('plans no AVIF when the codec cannot encode it, rather than planning a missing object', () => {
    const plan = planDerivatives(PRODUCT_ID, IMAGE_ID, 1000, nodeCodecWithoutAvif().formats);
    expect(plan.some((entry) => entry.format === 'avif')).toBe(false);
    expect(plan.some((entry) => entry.format === 'webp')).toBe(true);
  });
});

describe('generation with the real codec', () => {
  it('writes every planned object, in the format it claims', async () => {
    const codec = await nodeCodec();
    const { bucket, objects } = memoryBucket();
    const raw = { width: 1000, height: 600, rgba: makeRgba(1000, 600) };

    const result = await generateDerivatives({
      bucket,
      codec,
      raw,
      productId: PRODUCT_ID,
      imageId: IMAGE_ID,
    });

    expect(result.failed).toStrictEqual([]);
    expect(result.complete).toBe(true);
    expect(result.widths).toStrictEqual([320, 480, 640, 960]);
    expect(result.formats).toStrictEqual(['avif', 'webp', 'jpeg']);

    // Every object is really the format its key says. Signatures, not sizes.
    for (const [key, object] of objects) {
      const sniffed = sniffImageType(object.bytes.subarray(0, 32));
      expect(sniffed.ok).toBe(true);
      if (!sniffed.ok) continue;
      if (key.endsWith('.avif')) expect(sniffed.type.format).toBe('avif');
      if (key.endsWith('.webp')) expect(sniffed.type.format).toBe('webp');
      if (key.endsWith('.jpeg')) expect(sniffed.type.format).toBe('jpeg');
      expect(object.bytes.length).toBeGreaterThan(64);
    }

    // The stored derivatives really are at the width they are named for.
    const webp960 = objects.get(`products/${PRODUCT_ID}/${IMAGE_ID}/960.webp`);
    expect(webp960).toBeDefined();
    const decoded = await codec.decode(webp960?.bytes ?? new Uint8Array(), {
      format: 'webp',
      mime: 'image/webp',
      ext: 'webp',
    });
    expect(decoded?.width).toBe(960);
    expect(decoded?.height).toBe(576);
  }, 120_000);

  it('never writes a derivative wider than the original', async () => {
    const codec = await nodeCodec();
    const { bucket, objects } = memoryBucket();
    const raw = { width: 820, height: 500, rgba: makeRgba(820, 500) };

    await generateDerivatives({ bucket, codec, raw, productId: PRODUCT_ID, imageId: IMAGE_ID });

    const widths = [...objects.keys()].map((key) =>
      Number.parseInt(key.split('/').pop()?.split('.')[0] ?? '0', 10),
    );
    expect(Math.max(...widths)).toBeLessThanOrEqual(820);
    expect(widths).toContain(640);
    expect(widths).not.toContain(960);
  }, 120_000);

  it('produces a 24 px WebP LQIP as an inlinable data URL', async () => {
    const codec = await nodeCodec();
    const lqip = await buildLqip(codec, { width: 1200, height: 800, rgba: makeRgba(1200, 800) });
    expect(lqip).not.toBeNull();
    expect(lqip?.startsWith('data:image/webp;base64,')).toBe(true);
    // Small enough that inlining it beats requesting it.
    expect((lqip ?? '').length).toBeLessThan(4000);
  }, 120_000);
});

describe('the stored original is sanitized, not the uploaded bytes', () => {
  it('re-encodes from decoded pixels, so container metadata cannot survive', async () => {
    const codec = await nodeCodec();
    const raw = { width: 900, height: 600, rgba: makeRgba(900, 600) };

    const jpeg = await sanitizeOriginal(codec, raw, 'jpeg');
    expect(jpeg.mime).toBe('image/jpeg');
    expect(jpeg.ext).toBe('jpg');
    const jpegSniff = sniffImageType(jpeg.bytes.subarray(0, 32));
    expect(jpegSniff.ok && jpegSniff.type.format).toBe('jpeg');

    // A PNG or AVIF original is stored as WebP, and the record's `mime` says so — the
    // substitution is explicit rather than implied by an extension.
    for (const format of ['png', 'webp', 'avif'] as const) {
      const stored = await sanitizeOriginal(codec, raw, format);
      expect(stored.mime).toBe('image/webp');
      const sniffed = sniffImageType(stored.bytes.subarray(0, 32));
      expect(sniffed.ok && sniffed.type.format).toBe('webp');
    }
  }, 120_000);

  it('strips an appended payload: bytes after the image data do not survive a decode', async () => {
    const codec = await nodeCodec();
    const png = makePng(900, 600);
    const payload = new Uint8Array(Buffer.from('<?php system($_GET[0]); ?>', 'ascii'));
    const polyglot = new Uint8Array([...png, ...payload]);

    // The file still sniffs as a PNG and still validates — appending bytes to a PNG does not
    // make it not a PNG. What matters is that the *stored* object is a re-encode.
    const outcome = await validateUpload(
      fileFrom('polyglot.png', 'image/png', polyglot),
      (bytes, type) => codec.decode(bytes, type),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = await sanitizeOriginal(
      codec,
      { width: outcome.image.width, height: outcome.image.height, rgba: outcome.image.pixels! },
      'png',
    );
    const haystack = Buffer.from(stored.bytes).toString('latin1');
    expect(haystack).not.toContain('<?php');
  }, 120_000);
});

describe('AVIF, which the design’s named codec cannot do on its own', () => {
  it('round-trips: an AVIF upload decodes, and an AVIF derivative is real AVIF', async () => {
    const codec = await nodeCodec();
    expect(codec.formats).toContain('avif');

    const raw = { width: 900, height: 600, rgba: makeRgba(900, 600) };
    const encoded = await codec.encode(raw, 'avif', 50);
    const sniffed = sniffImageType(encoded.subarray(0, 32));
    expect(sniffed.ok && sniffed.type.format).toBe('avif');

    // And the same bytes come back in as an accepted upload (Requirement 15.1).
    const outcome = await validateUpload(
      fileFrom('photo.avif', 'image/avif', encoded),
      (bytes, type) => codec.decode(bytes, type),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.image.type.format).toBe('avif');
      expect(outcome.image.width).toBe(900);
      expect(outcome.image.height).toBe(600);
    }
  }, 120_000);

  it('refuses an AVIF upload when no AVIF decoder is available, rather than storing nothing', async () => {
    const withAvif = await nodeCodec();
    const avif = await withAvif.encode(
      { width: 900, height: 600, rgba: makeRgba(900, 600) },
      'avif',
      50,
    );
    const codec = nodeCodecWithoutAvif();
    const outcome = await validateUpload(
      fileFrom('photo.avif', 'image/avif', avif),
      (bytes, type) => codec.decode(bytes, type),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('DECODE_FAILED');
  }, 120_000);
});
