/**
 * Key-value adapter — Netlify Blobs behind the project's `KeyValueStore` interface.
 *
 * Three logical namespaces used this surface historically (Cloudflare KV): admin `SESSIONS`,
 * product `DRAFTS`, and `RATELIMIT` counters. Each maps to its own Netlify Blobs store, so the
 * data persists across deploys and function restarts and is shared across invocations and users —
 * which is exactly what admin sessions, draft previews and rate-limit windows require.
 *
 * **TTL emulation.** KV had a native `expirationTtl`; Blobs has none. The adapter stores an
 * `expiresAt` epoch in the entry's metadata and enforces it on read: an expired entry is deleted
 * and reported as absent (lazy expiry). This preserves the session and rate-limit semantics
 * exactly — those modules already re-check expiry in application code (`readSession` compares
 * `expiresAt`/`lastSeenAt`; the rate-limit window compares `resetAt`), so a lazily-expired blob and
 * a natively-expired KV key are indistinguishable to them. The old 60 s KV minimum TTL no longer
 * applies and the callers' `Math.max(60, ...)` simply becomes a harmless floor.
 *
 * **list.** Sessions/drafts occasionally list by prefix; the admin never lists sessions, and drafts
 * are listed by the product index. Blobs' `list({prefix})` is drained fully and returned as a
 * complete (uncursored) page, matching how the callers consume it.
 */

import { getStore, type Store } from '@netlify/blobs';

import type { KeyValuePutOptions, KeyValueStore } from './types';

interface Envelope {
  /** Epoch ms when this entry expires, or null for no expiry. */
  expiresAt: number | null;
}

class BlobKeyValueStore implements KeyValueStore {
  constructor(private readonly store: Store) {}

  async get(key: string, type?: 'text'): Promise<string | null>;
  async get(key: string, type: 'json'): Promise<unknown>;
  async get(key: string, type: 'text' | 'json' = 'text'): Promise<unknown> {
    const result = await this.store.getWithMetadata(key, { type: 'text' });
    if (result === null) return null;
    const envelope = (result.metadata ?? {}) as Partial<Envelope>;
    if (
      typeof envelope.expiresAt === 'number' &&
      envelope.expiresAt > 0 &&
      Date.now() >= envelope.expiresAt
    ) {
      // Lazy expiry: remove and report absent, exactly as an expired KV key would read.
      await this.store.delete(key);
      return null;
    }
    const text = result.data;
    if (type === 'json') {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    }
    return text;
  }

  async put(key: string, value: string, options?: KeyValuePutOptions): Promise<void> {
    const expiresAt =
      options?.expirationTtl === undefined ? null : Date.now() + options.expirationTtl * 1000;
    const envelope: Envelope = { expiresAt };
    await this.store.set(key, value, { metadata: envelope as unknown as Record<string, unknown> });
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const keys: { name: string }[] = [];
    const iterator = this.store.list({
      paginate: true,
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
    });
    for await (const page of iterator) {
      for (const blob of page.blobs) keys.push({ name: blob.key });
    }
    return { keys, list_complete: true };
  }
}

/** A KV-shaped store backed by a named Netlify Blobs store. */
export function createBlobKeyValueStore(name: string): KeyValueStore {
  return new BlobKeyValueStore(getStore({ name, consistency: 'strong' }));
}
