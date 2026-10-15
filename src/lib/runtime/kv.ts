/**
 * Key-value adapter — Cloudflare KV behind the project's `KeyValueStore` interface.
 *
 * This is the Cloudflare counterpart of `src/lib/runtime/blob-kv.ts`. Three logical namespaces use
 * this surface: admin `SESSIONS`, product `DRAFTS`, and `RATELIMIT` counters. On Cloudflare each is
 * a real KV namespace binding, so the data persists across deploys and is shared across invocations
 * and users — exactly what admin sessions, draft previews and rate-limit windows require.
 *
 * **TTL is native here.** The Blobs adapter had to emulate `expirationTtl` with an `expiresAt`
 * metadata field and lazy delete-on-read, because Blobs has no expiry. KV has `{ expirationTtl }`
 * built in, so this adapter passes it straight through and KV evicts the key itself. The callers
 * already re-check expiry in application code (`readSession` compares `expiresAt`/`lastSeenAt`; the
 * rate-limit window compares `resetAt`), so a natively-expired KV key and a lazily-expired blob are
 * indistinguishable to them — the behaviour the shared tests assert is preserved.
 *
 * **KV's 60 s minimum TTL applies here.** `expirationTtl` below 60 is rejected by KV. Every caller
 * already floors its TTL at 60 (`rate-limit.ts` uses `Math.max(60, ...)`; sessions are hours), so
 * this is never hit in practice; the adapter still clamps defensively so a future caller cannot
 * send a sub-minute TTL that KV would throw on.
 *
 * **list.** KV's `list({ prefix, cursor })` is natively paginated and returns `{ keys, list_complete,
 * cursor }`. The project's interface is the same shape, so this is a near pass-through: the keys are
 * mapped to `{ name }` and `list_complete` / `cursor` are surfaced as KV reports them. The callers
 * (draft listing) consume a single page, which KV returns by default.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { KeyValuePutOptions, KeyValueStore } from './types';

/** KV rejects an `expirationTtl` below this many seconds. */
const KV_MIN_TTL_SECONDS = 60;

class CloudflareKeyValueStore implements KeyValueStore {
  constructor(private readonly kv: KVNamespace) {}

  async get(key: string, type?: 'text'): Promise<string | null>;
  async get(key: string, type: 'json'): Promise<unknown>;
  async get(key: string, type: 'text' | 'json' = 'text'): Promise<unknown> {
    if (type === 'json') {
      // KV parses JSON itself and returns `null` for a missing key or unparseable body, which
      // matches the Blobs adapter's "return null on parse failure" behaviour.
      return await this.kv.get(key, 'json');
    }
    return await this.kv.get(key, 'text');
  }

  async put(key: string, value: string, options?: KeyValuePutOptions): Promise<void> {
    if (options?.expirationTtl === undefined) {
      await this.kv.put(key, value);
      return;
    }
    // Clamp to KV's minimum so a sub-minute TTL cannot make KV throw; see the file header.
    const expirationTtl = Math.max(KV_MIN_TTL_SECONDS, Math.floor(options.expirationTtl));
    await this.kv.put(key, value, { expirationTtl });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const result = await this.kv.list({
      ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    const keys = result.keys.map((entry) => ({ name: entry.name }));
    // `list_complete` is `true` when KV has returned the final page. When it is `false` KV also
    // provides a `cursor` to continue; surface it so a caller that paginates can, while the current
    // single-page callers simply ignore it.
    return result.list_complete
      ? { keys, list_complete: true }
      : { keys, list_complete: false, cursor: result.cursor };
  }
}

/** A KV-shaped store backed by a Cloudflare KV namespace binding. */
export function createCloudflareKeyValueStore(kv: KVNamespace): KeyValueStore {
  return new CloudflareKeyValueStore(kv);
}
