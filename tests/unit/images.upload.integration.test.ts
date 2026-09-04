import type { R2Bucket } from '@cloudflare/workers-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import { deletedKey, IMAGE_CACHE_CONTROL, originalKey } from '@/lib/images/srcset';
import { generateDerivatives, sanitizeOriginal } from '@/lib/images/derivatives';
import { generateImageId, validateUpload } from '@/lib/images/validate';
import { keyCandidates, parseImageRequest } from '@/lib/images/delivery';
import { listImageKeys, putImageObject, restoreImage, softDeleteImage } from '@/lib/images/store';
import { fileFrom, makePng, nodeCodec } from '../fixtures/images';
import type { ImageCodec } from '@/lib/images/codec';

/**
 * The upload path against a **real local R2 binding**.
 *
 * `getPlatformProxy` starts the same workerd-backed R2 the Worker gets in production, driven by
 * this project's own `wrangler.toml`. That matters more than it looks: an in-memory fake would
 * let this suite pass while `httpMetadata` was being dropped, while `list` pagination was
 * mishandled, or while the delete-after-copy ordering in the soft delete was wrong — and the
 * soft delete is the only recovery path images have, since they are deliberately not in Git.
 *
 * The codec is the production codec (Photon + jSquash), so what is written here is what would
 * be written by an upload.
 *
 * Requirements: 15.1–15.13, 15.16, 22.9.
 */

const PRODUCT_ID = 'p_r2test0001';

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let media: R2Bucket;
let codec: ImageCodec;

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: './wrangler.toml', persist: false });
  media = (proxy.env as { MEDIA: R2Bucket }).MEDIA;
  codec = await nodeCodec();
}, 180_000);

afterAll(async () => {
  await proxy?.dispose();
}, 60_000);

/** The upload endpoint's own sequence: validate → sanitize → store original → derivatives. */
async function uploadOne(bytes: Uint8Array, filename = 'photo.png') {
  const outcome = await validateUpload(fileFrom(filename, 'image/png', bytes), (input, type) =>
    codec.decode(input, type),
  );
  if (!outcome.ok) return { ok: false as const, error: outcome.error };

  const imageId = generateImageId();
  const raw = {
    width: outcome.image.width,
    height: outcome.image.height,
    rgba: outcome.image.pixels!,
  };
  const sanitized = await sanitizeOriginal(codec, raw, outcome.image.type.format);
  const key = originalKey(PRODUCT_ID, imageId, sanitized.ext);
  await putImageObject(media, { key, bytes: sanitized.bytes, contentType: sanitized.mime });

  const generated = await generateDerivatives({
    bucket: media,
    codec,
    raw,
    productId: PRODUCT_ID,
    imageId,
  });

  return { ok: true as const, imageId, key, mime: sanitized.mime, generated, image: outcome.image };
}

describe('an accepted upload lands in R2 exactly as the record describes', () => {
  it('stores the sanitized original and every planned derivative', async () => {
    const result = await uploadOne(makePng(1400, 900));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The server-generated key: product id, generated image id, sniffed extension. No part of
    // it comes from the client's filename (Requirement 15.7).
    expect(result.key).toBe(`products/${PRODUCT_ID}/${result.imageId}/original.webp`);
    expect(result.key).not.toContain('photo');
    expect(/^img_[a-z0-9]{10}$/.test(result.imageId)).toBe(true);

    const original = await media.get(result.key);
    expect(original).not.toBeNull();
    expect(original?.httpMetadata?.contentType).toBe('image/webp');
    // The immutable header is stored with the object, so the delivery route serves it without
    // having to know anything about the object.
    expect(original?.httpMetadata?.cacheControl).toBe(IMAGE_CACHE_CONTROL);

    expect(result.generated.complete).toBe(true);
    expect(result.generated.widths).toStrictEqual([320, 480, 640, 960, 1280]);

    const keys = await listImageKeys(media, PRODUCT_ID, result.imageId);
    // 5 widths × 2 formats + 1 JPEG + the original.
    expect(keys).toHaveLength(12);
    for (const entry of result.generated.written) {
      const object = await media.get(entry.key);
      expect(object).not.toBeNull();
      expect(object?.httpMetadata?.cacheControl).toBe(IMAGE_CACHE_CONTROL);
      expect((object?.size ?? 0) > 0).toBe(true);
    }
  }, 300_000);

  it('serves the negotiated format from R2, and falls back to the original', async () => {
    const result = await uploadOne(makePng(1000, 700));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A `.webp` URL from a browser that accepts AVIF resolves to the AVIF object.
    const request = parseImageRequest(`${PRODUCT_ID}/${result.imageId}-640.webp`);
    expect(request).not.toBeNull();
    const candidates = keyCandidates(request!, 'image/avif,image/webp,image/*,*/*');
    expect(candidates[0]?.key).toBe(`products/${PRODUCT_ID}/${result.imageId}/640.avif`);
    const first = await media.get(candidates[0]?.key ?? '');
    expect(first).not.toBeNull();

    // A browser accepting neither gets exactly what it asked for.
    const legacy = keyCandidates(request!, 'image/jpeg');
    expect(legacy[0]?.key).toBe(`products/${PRODUCT_ID}/${result.imageId}/640.webp`);

    // A width that was never generated (above the original) falls through the derivative
    // candidates to the stored original, so a stale URL still returns the photograph rather
    // than a 404 (Requirement 15.13).
    const tooWide = parseImageRequest(`${PRODUCT_ID}/${result.imageId}-2000.webp`);
    const wideCandidates = keyCandidates(tooWide!, 'image/webp');
    let served: string | null = null;
    for (const candidate of wideCandidates) {
      const object = await media.get(candidate.key);
      if (object !== null) {
        served = candidate.key;
        break;
      }
    }
    expect(served).toBe(result.key);
  }, 300_000);

  it('rejects a file whose bytes are not an image, leaving nothing in the bucket', async () => {
    const before = (await media.list({ prefix: `products/${PRODUCT_ID}/` })).objects.length;
    const script = new Uint8Array(Buffer.from('<?php system($_GET[0]); ?>', 'ascii'));
    const outcome = await validateUpload(
      fileFrom('photo.png', 'image/png', script),
      (input, type) => codec.decode(input, type),
    );
    expect(outcome.ok).toBe(false);
    const after = (await media.list({ prefix: `products/${PRODUCT_ID}/` })).objects.length;
    expect(after).toBe(before);
  }, 120_000);
});

describe('deletion is a move, and it is reversible', () => {
  it('moves every object under deleted/ and can restore one', async () => {
    const result = await uploadOne(makePng(900, 600));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = await listImageKeys(media, PRODUCT_ID, result.imageId);
    expect(before.length).toBeGreaterThan(1);

    const moved = await softDeleteImage(media, PRODUCT_ID, result.imageId);
    expect(moved.failed).toStrictEqual([]);
    expect(moved.moved.sort()).toStrictEqual(before.sort());

    // Gone from the live prefix…
    expect(await listImageKeys(media, PRODUCT_ID, result.imageId)).toStrictEqual([]);
    // …and present under deleted/, with the provenance a recovery needs.
    for (const key of before) {
      const object = await media.get(deletedKey(key));
      expect(object).not.toBeNull();
      expect(object?.customMetadata?.originalKey).toBe(key);
      expect(typeof object?.customMetadata?.deletedAt).toBe('string');
    }

    // The 30-day window is an R2 bucket lifecycle rule (deployment configuration); what the
    // code owes is that the object is there to be restored.
    expect(await restoreImage(media, result.key)).toBe(true);
    const restored = await media.get(result.key);
    expect(restored).not.toBeNull();
    expect(restored?.httpMetadata?.cacheControl).toBe(IMAGE_CACHE_CONTROL);
    expect(await media.get(deletedKey(result.key))).toBeNull();
  }, 300_000);

  it('reports a restore of something that was never deleted as false', async () => {
    expect(await restoreImage(media, `products/${PRODUCT_ID}/img_nonexisten/original.webp`)).toBe(
      false,
    );
  }, 60_000);
});
