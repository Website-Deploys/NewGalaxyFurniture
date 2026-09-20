/**
 * Object bucket adapter â€” Netlify Blobs behind the project's `ObjectBucket` interface.
 *
 * The image pipeline (`images/store`, `images/delivery`, `images/derivatives`) and the `/img/**`
 * route are written against `ObjectBucket.put/get/delete/list`, historically an R2 bucket. This
 * module implements that surface over a Netlify Blobs store, so image originals, derivatives and
 * the soft-deleted `deleted/` prefix all persist in Netlify Blobs â€” durable across deploys,
 * function restarts and cache clears, and shared across every function invocation and every user.
 *
 * **Keys.** Blob keys are the same content-addressed paths the pipeline already produces
 * (`products/{productId}/{imageId}/...`), so no URL or product record changes.
 *
 * **HTTP metadata.** R2 carried `contentType`/`cacheControl` as first-class object metadata; Blobs
 * carries an arbitrary JSON `metadata` object. `put` writes them there and `get` reads them back,
 * so the `/img/**` response still sets the right `content-type` and immutable cache header.
 *
 * **ETag.** Blobs returns an `etag` from `getWithMetadata`; it is surfaced as `httpEtag` for the
 * conditional-response path. When absent, a stable fallback derived from the key is used so the
 * response always carries one.
 */

import { getStore, type Store } from '@netlify/blobs';

import type { ObjectBucket, ObjectListResult, ObjectPutOptions, StoredObjectBody } from './types';

interface BlobMetadata {
  contentType?: string;
  cacheControl?: string;
  custom?: Record<string, string>;
}

function toUint8Array(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value;
}

class BlobObjectBucket implements ObjectBucket {
  constructor(private readonly store: Store) {}

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: ObjectPutOptions,
  ): Promise<void> {
    const metadata: BlobMetadata = {
      ...(options?.httpMetadata?.contentType === undefined
        ? {}
        : { contentType: options.httpMetadata.contentType }),
      ...(options?.httpMetadata?.cacheControl === undefined
        ? {}
        : { cacheControl: options.httpMetadata.cacheControl }),
      ...(options?.customMetadata === undefined ? {} : { custom: options.customMetadata }),
    };
    await this.store.set(key, toUint8Array(value), {
      metadata: metadata as Record<string, unknown>,
    });
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const result = await this.store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (result === null) return null;
    const meta = (result.metadata ?? {}) as BlobMetadata;
    const bytes = result.data;
    const etag = result.etag ?? `"${key.length.toString(16)}-${String(bytes.byteLength)}"`;
    return {
      httpMetadata: {
        ...(meta.contentType === undefined ? {} : { contentType: meta.contentType }),
        ...(meta.cacheControl === undefined ? {} : { cacheControl: meta.cacheControl }),
      },
      ...(meta.custom === undefined ? {} : { customMetadata: meta.custom }),
      httpEtag: etag,
      size: bytes.byteLength,
      arrayBuffer: () => Promise.resolve(bytes),
      body: new Blob([bytes]).stream(),
    };
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<ObjectListResult> {
    // `paginate: true` yields an async iterator of pages; the pipeline only needs the full set
    // under a prefix (per-image key groups are small), so all pages are drained here and the
    // result reported as untruncated â€” the callers loop on `truncated`, which is then a no-op.
    const objects: { key: string }[] = [];
    const iterator = this.store.list({
      paginate: true,
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
    });
    for await (const page of iterator) {
      for (const blob of page.blobs) objects.push({ key: blob.key });
    }
    return { objects, truncated: false };
  }
}

/** The media bucket. `getStore` needs no credentials inside a Netlify Function. */
export function createBlobObjectBucket(name: string): ObjectBucket {
  return new BlobObjectBucket(getStore({ name, consistency: 'strong' }));
}
