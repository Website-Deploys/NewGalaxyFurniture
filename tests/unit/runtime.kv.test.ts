/**
 * Focused tests for the KV adapter (`src/lib/runtime/kv.ts`).
 *
 * The adapter wraps a Cloudflare `KVNamespace` and exposes the project's `KeyValueStore` interface.
 * Unlike the Netlify Blobs adapter — which emulates TTL with metadata and lazy delete — KV has
 * native `expirationTtl`, so these tests assert the adapter PASSES the TTL through to the binding
 * (clamped to KV's 60 s minimum) rather than re-implementing expiry, and that `get`/`list` map to
 * the project shapes.
 *
 * The fake records the exact options handed to `put`/`list` so the pass-through and the clamp are
 * observable, and implements only the `KVNamespace` surface the adapter calls.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { createCloudflareKeyValueStore } from '@/lib/runtime/kv';

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

class FakeKV {
  private readonly store = new Map<string, string>();
  readonly puts: PutCall[] = [];
  listArg: { prefix?: string; cursor?: string } | undefined;
  /** When set, `list` returns this instead of deriving from the store (to test cursor passthrough). */
  listResult:
    | { keys: { name: string }[]; list_complete: boolean; cursor?: string }
    | undefined;

  async get(key: string, type: 'text' | 'json' = 'text'): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, ...(options === undefined ? {} : { options }) });
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    this.listArg = options;
    if (this.listResult !== undefined) return this.listResult;
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

describe('createCloudflareKeyValueStore', () => {
  let fake: FakeKV;
  let kv: ReturnType<typeof createCloudflareKeyValueStore>;

  beforeEach(() => {
    fake = new FakeKV();
    kv = createCloudflareKeyValueStore(fake as unknown as KVNamespace);
  });

  it('get returns text, parsed JSON, or null', async () => {
    await kv.put('t', 'plain');
    await kv.put('j', JSON.stringify({ a: 1 }));
    expect(await kv.get('t')).toBe('plain');
    expect(await kv.get('j', 'json')).toEqual({ a: 1 });
    expect(await kv.get('missing')).toBeNull();
  });

  it('put passes native expirationTtl through to KV (not emulated)', async () => {
    await kv.put('s', 'v', { expirationTtl: 43_200 }); // 12 h session TTL
    const call = fake.puts.at(-1);
    expect(call?.options?.expirationTtl).toBe(43_200);
  });

  it('put with no TTL sends no expiration option', async () => {
    await kv.put('s', 'v');
    expect(fake.puts.at(-1)?.options).toBeUndefined();
  });

  it('put clamps a sub-minute TTL to KV minimum of 60 s', async () => {
    await kv.put('s', 'v', { expirationTtl: 5 });
    expect(fake.puts.at(-1)?.options?.expirationTtl).toBe(60);
  });

  it('put floors a fractional TTL to an integer', async () => {
    await kv.put('s', 'v', { expirationTtl: 90.9 });
    expect(fake.puts.at(-1)?.options?.expirationTtl).toBe(90);
  });

  it('list maps keys to { name } and reports completion', async () => {
    await kv.put('rl:a', '1');
    await kv.put('rl:b', '1');
    await kv.put('other', '1');
    const result = await kv.list({ prefix: 'rl:' });
    expect(result.list_complete).toBe(true);
    expect(result.keys.map((k) => k.name).sort()).toEqual(['rl:a', 'rl:b']);
    expect(fake.listArg).toEqual({ prefix: 'rl:' });
  });

  it('list surfaces the cursor when KV reports an incomplete page', async () => {
    fake.listResult = { keys: [{ name: 'x' }], list_complete: false, cursor: 'CURSOR123' };
    const result = await kv.list({ prefix: 'x' });
    expect(result.list_complete).toBe(false);
    expect(result.cursor).toBe('CURSOR123');
  });

  it('delete removes the key', async () => {
    await kv.put('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });
});
