/**
 * Object bucket adapter — Cloudflare R2 behind the project's `ObjectBucket` interface.
 *
 * This is the Cloudflare counterpart of `src/lib/runtime/blob-bucket.ts`. The image pipeline
 * (`images/store`, `images/derivatives`) and the `/img/**` route are written against
 * `ObjectBucket.put/get/delete/list`, and this module implements that surface over an R2 bucket
 * binding. Image originals, derivatives and the soft-deleted `deleted/` prefix all live in R2.
 *
 * The project's `ObjectBucket` interface was *modelled on* R2 (see `runtime/types.ts`), so most of
 * this adapter is a narrowing pass-through rather than a translation:
 *
 * **Keys.** The content-addressed paths the pipeline produces (`products/{productId}/{imageId}/...`)
 * are used verbatim, so no URL or product record changes.
 *
 * **HTTP metadata.** R2 carries `httpMetadata` (`contentType`, `cacheControl`) and `customMetadata`
 * as first-class fields on put and get, which is exactly the project's shape — the Blobs adapter had
 * to pack these into an arbitrary JSON `metadata` object and unpack them; here they pass straight
 * through.
 *
 * **ETag.** R2's object carries `httpEtag` directly; it is surfaced as-is for the `/img/**`
 * conditional-response path. R2 always provides one, so unlike the Blobs adapter there is no
 * key-derived fallback to synthesise.
 *
 * **Body.** `R2ObjectBody` exposes both `arrayBuffer()` and a `body` ReadableStream. The project's
 * `StoredObjectBody` wants `arrayBuffer(): Promise<ArrayBuffer>` and a `body` stream, so both are
 * surfaced directly — the `/img/**` route streams `body` for the passthrough response and the
 * derivative pipeline reads `arrayBuffer()`.
 */

import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types';

import type {
  ObjectBucket,
  ObjectListResult,
  ObjectPutOptions,
  StoredObjectBody,
} from './types';

function toArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value;
}

/** Shape an `R2ObjectBody` into the project's `StoredObjectBody`. */
function toStoredObjectBody(object: R2ObjectBody): StoredObjectBody {
  const contentType = object.httpMetadata?.contentType;
  const cacheControl = object.httpMetadata?.cacheControl;
  return {
    httpMetadata: {
      ...(contentType === undefined ? {} : { contentType }),
      ...(cacheControl === undefined ? {} : { cacheControl }),
    },
    ...(object.customMetadata === undefined ? {} : { customMetadata: object.customMetadata }),
    httpEtag: object.httpEtag,
    size: object.size,
    arrayBuffer: () => object.arrayBuffer(),
    // R2's `body` is the Workers `ReadableStream`; the project interface types it as the DOM
    // `ReadableStream`. They are the same runtime object, so cast at this single boundary rather
    // than leaking the Workers type through `StoredObjectBody`.
    body: object.body as unknown as ReadableStream,
  };
}

class CloudflareObjectBucket implements ObjectBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: ObjectPutOptions,
  ): Promise<void> {
    await this.bucket.put(key, toArrayBuffer(value), {
      ...(options?.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
      ...(options?.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
    });
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const object = await this.bucket.get(key);
    // R2's `get` returns `R2ObjectBody` (with a body) or `null`. A plain `R2Object` with no body is
    // only returned by `head`, which this adapter does not use, so a non-null result always has a
    // body to stream.
    if (object === null) return null;
    return toStoredObjectBody(object);
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<ObjectListResult> {
    const result = await this.bucket.list({
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    const objects = result.objects.map((object: R2Object) => ({ key: object.key }));
    // R2 reports `truncated` and, when truncated, a `cursor` to continue. The image pipeline reads
    // whole small per-image key groups under a prefix, so it consumes a single page; surface the
    // cursor anyway so a future paginating caller is supported.
    return result.truncated
      ? { objects, truncated: true, cursor: result.cursor }
      : { objects, truncated: false };
  }
}

/** An object store backed by a Cloudflare R2 bucket binding (`env.MEDIA`). */
export function createCloudflareObjectBucket(bucket: R2Bucket): ObjectBucket {
  return new CloudflareObjectBucket(bucket);
}
