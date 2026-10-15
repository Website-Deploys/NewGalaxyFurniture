/**
 * Focused tests for the R2 adapter (`src/lib/runtime/r2.ts`).
 *
 * The adapter wraps a Cloudflare `R2Bucket` and exposes the project's `ObjectBucket` interface. R2
 * is the native source of the shapes the project interface was modelled on, so the adapter is a
 * narrowing pass-through; these tests assert the round-trip the `/img/**` route and the image
 * pipeline depend on:
 *
 *   - `httpMetadata` (contentType / cacheControl) and `customMetadata` survive put → get;
 *   - `httpEtag` is surfaced as-is (R2 always provides one, no synthesised fallback);
 *   - `size`, `arrayBuffer()` bytes and a readable `body` stream are correct;
 *   - `get` of a missing key is null;
 *   - `list` maps objects to `{ key }` and reports `truncated` + an optional cursor.
 *
 * The fake implements only the `R2Bucket` surface the adapter calls (`put`, `get`, `delete`, `list`)
 * and returns an `R2ObjectBody`-shaped object from `get`.
 */

import type { R2Bucket } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCloudflareObjectBucket } from '@/lib/runtime/r2';

interface StoredR2 {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

class FakeR2 {
  private readonly store = new Map<string, StoredR2>();
  listArg: { prefix?: string; cursor?: string } | undefined;
  listTruncated = false;
  listCursor: string | undefined;

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
    this.store.set(key, {
      bytes,
      ...(options?.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
      ...(options?.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
    });
  }

  async get(key: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    const buffer = entry.bytes.buffer.slice(
      entry.bytes.byteOffset,
      entry.bytes.byteOffset + entry.bytes.byteLength,
    ) as ArrayBuffer;
    // Shape an R2ObjectBody: metadata fields, an etag R2 always provides, size, and both body forms.
    return {
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      httpEtag: `"etag-${key}"`,
      size: entry.bytes.byteLength,
      arrayBuffer: () => Promise.resolve(buffer),
      body: new Blob([buffer]).stream(),
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<unknown> {
    this.listArg = options;
    const prefix = options?.prefix ?? '';
    const objects = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }));
    return this.listTruncated
      ? { objects, truncated: true, cursor: this.listCursor }
      : { objects, truncated: false };
  }
}

async function streamToText(stream: ReadableStream | null): Promise<string> {
  if (stream === null) return '';
  return await new Response(stream).text();
}

describe('createCloudflareObjectBucket', () => {
  let fake: FakeR2;
  let bucket: ReturnType<typeof createCloudflareObjectBucket>;

  beforeEach(() => {
    fake = new FakeR2();
    bucket = createCloudflareObjectBucket(fake as unknown as R2Bucket);
  });

  it('round-trips bytes, http metadata and custom metadata', async () => {
    const bytes = new TextEncoder().encode('image-bytes');
    await bucket.put('products/p1/i1/original.jpg', bytes, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
      customMetadata: { productId: 'p1' },
    });

    const object = await bucket.get('products/p1/i1/original.jpg');
    expect(object).not.toBeNull();
    expect(object?.httpMetadata).toEqual({
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(object?.customMetadata).toEqual({ productId: 'p1' });
    expect(object?.size).toBe(bytes.byteLength);
    expect(object?.httpEtag).toBe('"etag-products/p1/i1/original.jpg"');

    const buf = await object?.arrayBuffer();
    expect(new TextDecoder().decode(buf)).toBe('image-bytes');
    expect(await streamToText(object?.body ?? null)).toBe('image-bytes');
  });

  it('accepts an ArrayBuffer value as well as a Uint8Array', async () => {
    const buffer = new TextEncoder().encode('abc').buffer;
    await bucket.put('k', buffer);
    const object = await bucket.get('k');
    expect(new TextDecoder().decode(await object?.arrayBuffer())).toBe('abc');
  });

  it('get of a missing key is null', async () => {
    expect(await bucket.get('nope')).toBeNull();
  });

  it('put with no options yields empty httpMetadata and no customMetadata', async () => {
    await bucket.put('k', new TextEncoder().encode('x'));
    const object = await bucket.get('k');
    expect(object?.httpMetadata).toEqual({});
    expect(object?.customMetadata).toBeUndefined();
  });

  it('list maps objects to { key } and reports not truncated by default', async () => {
    await bucket.put('products/p1/a', new Uint8Array([1]));
    await bucket.put('products/p1/b', new Uint8Array([2]));
    await bucket.put('deleted/x', new Uint8Array([3]));
    const result = await bucket.list({ prefix: 'products/p1/' });
    expect(result.truncated).toBe(false);
    expect(result.objects.map((o) => o.key).sort()).toEqual(['products/p1/a', 'products/p1/b']);
    expect(fake.listArg).toEqual({ prefix: 'products/p1/' });
  });

  it('list surfaces the cursor when R2 reports truncation', async () => {
    fake.listTruncated = true;
    fake.listCursor = 'R2CURSOR';
    await bucket.put('k', new Uint8Array([1]));
    const result = await bucket.list();
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe('R2CURSOR');
  });

  it('delete removes the object', async () => {
    await bucket.put('k', new Uint8Array([1]));
    await bucket.delete('k');
    expect(await bucket.get('k')).toBeNull();
  });
});
