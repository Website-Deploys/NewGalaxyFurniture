/**
 * R2 access for image objects: put, get, and the soft delete.
 *
 * Deletion is a **move, not a delete**. Images are the one part of the content model that is
 * not in Git, so there is no `git revert` for an accidental removal; the design's answer is a
 * `deleted/` prefix with a 30-day lifecycle rule, which makes the mistake recoverable
 * (Requirement 15.16). The R2 binding has no server-side copy, so the move is a read and a
 * write per object — which is why it runs after the response, not inside it.
 *
 * **The 30-day expiry is bucket configuration, not code.** R2 object lifecycle rules are set
 * on the bucket (dashboard or `wrangler r2 bucket lifecycle`), and `wrangler.toml` has no
 * field for them. This module's job is to put the objects where that rule can find them; the
 * rule itself is a deployment step, recorded in `wrangler.toml`'s comments.
 *
 * Requirements: 15.7, 15.16.
 */

import type { R2Bucket } from '@cloudflare/workers-types';

import { deletedKey, imagePrefix, IMAGE_CACHE_CONTROL } from './srcset';

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

/** Write one object with the immutable cache header baked into its metadata. */
export async function putImageObject(bucket: R2Bucket, object: StoredObject): Promise<void> {
  await bucket.put(object.key, object.bytes, {
    httpMetadata: {
      contentType: object.contentType,
      cacheControl: IMAGE_CACHE_CONTROL,
    },
  });
}

/** Every key under one image's prefix, following the list cursor to the end. */
export async function listImageKeys(
  bucket: R2Bucket,
  productId: string,
  imageId: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: imagePrefix(productId, imageId),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

export interface SoftDeleteResult {
  moved: string[];
  failed: string[];
}

/**
 * Move every object for one image under `deleted/`.
 *
 * A per-object failure is recorded rather than thrown: having moved nine of ten objects is
 * strictly better than aborting, and the caller logs the remainder. The original is
 * deleted only after its copy is written, so a failure mid-way leaves the object present
 * rather than lost.
 */
export async function softDeleteImage(
  bucket: R2Bucket,
  productId: string,
  imageId: string,
): Promise<SoftDeleteResult> {
  const keys = await listImageKeys(bucket, productId, imageId);
  const moved: string[] = [];
  const failed: string[] = [];

  for (const key of keys) {
    try {
      const object = await bucket.get(key);
      if (object === null) {
        failed.push(key);
        continue;
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      await bucket.put(deletedKey(key), bytes, {
        httpMetadata: {
          contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
        },
        customMetadata: { deletedAt: new Date().toISOString(), originalKey: key },
      });
      await bucket.delete(key);
      moved.push(key);
    } catch {
      failed.push(key);
    }
  }

  return { moved, failed };
}

/** Restore a soft-deleted image, for the recovery path the 30-day window exists for. */
export async function restoreImage(bucket: R2Bucket, key: string): Promise<boolean> {
  const object = await bucket.get(deletedKey(key));
  if (object === null) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      cacheControl: IMAGE_CACHE_CONTROL,
    },
  });
  await bucket.delete(deletedKey(key));
  return true;
}
