/**
 * Focused tests for the D1 SQL adapter (`src/lib/runtime/d1.ts`).
 *
 * The adapter wraps a Cloudflare `D1Database` and exposes the project's `SqlDatabase` interface.
 * There is no Worker here, so these tests back a minimal fake `D1Database` with Node's built-in
 * `node:sqlite` — the same engine D1 runs on — which lets the REAL application SQL execute through
 * the adapter. The point of these tests is the adapter's two jobs:
 *
 *   1. It passes statement text to D1 UNCHANGED (no placeholder rewriting). D1/SQLite accept both
 *      bare `?` and explicit `?1` natively, and the leads search reuses `?1` five times — so the
 *      adapter must NOT convert placeholders the way the Neon adapter does. This is asserted against
 *      the real leads-store SQL shape.
 *   2. It narrows D1's richer result objects to the project contract: `first()` → row | null,
 *      `all()` → `{ results }`, `run()` → `{ success }`, and `batch()` runs sequentially.
 *
 * The fake implements only the `D1Database`/`D1PreparedStatement` surface the adapter actually
 * calls (`prepare`, `bind`, `first`, `all`, `run`), typed loosely and cast at the boundary — it is a
 * test double for a runtime binding, not a reimplementation of D1.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { D1Database } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { createD1Database } from '@/lib/runtime/d1';

/* -------------------------------------------------------------------------- */
/* A node:sqlite-backed fake of the D1 binding surface the adapter uses.       */
/* -------------------------------------------------------------------------- */

class FakeD1Prepared {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeD1Prepared {
    return new FakeD1Prepared(this.db, this.sql, values);
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  private params(): unknown[] {
    // D1/SQLite bind positionally; `node:sqlite` takes the values in argument order and resolves
    // `?`/`?N` itself, exactly as D1 does. Coerce types node:sqlite accepts.
    return this.values.map((v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v as string | number | bigint | Uint8Array;
    });
  }

  async first<T>(): Promise<T | null> {
    const row = this.stmt().get(...(this.params() as never[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
    const results = this.stmt().all(...(this.params() as never[])) as T[];
    // Mimic D1's richer return so the adapter's narrowing to `{ results }` is actually exercised.
    return { results, success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    this.stmt().run(...(this.params() as never[]));
    return { success: true, meta: {} };
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string): FakeD1Prepared {
    return new FakeD1Prepared(this.db, sql);
  }
}

function fakeD1Binding(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      phone TEXT NOT NULL, message TEXT NOT NULL, product_slug TEXT, product_name TEXT,
      product_sku TEXT, product_url TEXT, budget TEXT, dimensions TEXT, image_key TEXT,
      source_path TEXT, referrer TEXT, ua_hash TEXT, country TEXT,
      status TEXT NOT NULL DEFAULT 'NEW', note TEXT, spam_score INTEGER DEFAULT 0
    );
    CREATE TABLE login_attempts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until TEXT);
  `);
  return new FakeD1(db) as unknown as D1Database;
}

/* -------------------------------------------------------------------------- */

describe('createD1Database', () => {
  let d1: ReturnType<typeof createD1Database>;

  beforeEach(() => {
    d1 = createD1Database(fakeD1Binding());
  });

  it('run() reports success and first() returns the inserted row or null', async () => {
    const insert = await d1
      .prepare(
        'INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?)',
      )
      .bind('email:abc', 3, null)
      .run();
    expect(insert).toEqual({ success: true });

    const row = await d1
      .prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?')
      .bind('email:abc')
      .first<{ fails: number; locked_until: string | null }>();
    expect(row).toEqual({ fails: 3, locked_until: null });

    const missing = await d1
      .prepare('SELECT fails FROM login_attempts WHERE key = ?')
      .bind('email:nope')
      .first();
    expect(missing).toBeNull();
  });

  it('all() narrows D1 result to { results } only', async () => {
    await d1.prepare('INSERT INTO leads (id, created_at, type, name, phone, message) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('lead_1', '2026-03-14T00:00:00.000Z', 'CONTACT', 'Asha', '+910000000000', 'hi')
      .run();
    const result = await d1.prepare('SELECT id FROM leads').all<{ id: string }>();
    // The adapter must return exactly { results }, not D1's { results, success, meta }.
    expect(Object.keys(result)).toEqual(['results']);
    expect(result.results).toEqual([{ id: 'lead_1' }]);
  });

  it('ON CONFLICT upsert runs unchanged (login_attempts pattern)', async () => {
    const upsert = async (fails: number): Promise<void> => {
      await d1
        .prepare(
          'INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until',
        )
        .bind('email:x', fails, null)
        .run();
    };
    await upsert(1);
    await upsert(7);
    const row = await d1
      .prepare('SELECT fails FROM login_attempts WHERE key = ?')
      .bind('email:x')
      .first<{ fails: number }>();
    expect(row?.fails).toBe(7);
  });

  it('passes ?1-reuse placeholders through unchanged (leads free-text search)', async () => {
    // The real leads search reuses ?1 five times with every other placeholder numbered. If the
    // adapter rewrote placeholders, ?1 would bind to the wrong argument and this would throw or
    // return the wrong rows. Verifying it runs AND filters correctly proves the passthrough.
    await d1.prepare('INSERT INTO leads (id, created_at, type, name, phone, message) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('lead_a', '2026-03-14T00:00:00.000Z', 'CONTACT', 'Teak Table buyer', '+911111111111', 'want a teak table')
      .run();
    await d1.prepare('INSERT INTO leads (id, created_at, type, name, phone, message) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('lead_b', '2026-03-14T00:00:00.000Z', 'CONTACT', 'Someone else', '+912222222222', 'a sofa')
      .run();

    const pattern = '%teak%';
    const { results } = await d1
      .prepare(
        "SELECT id FROM leads WHERE (name LIKE ?1 ESCAPE '\\' OR phone LIKE ?1 ESCAPE '\\' " +
          "OR message LIKE ?1 ESCAPE '\\' OR COALESCE(product_name, '') LIKE ?1 ESCAPE '\\' " +
          "OR COALESCE(product_sku, '') LIKE ?1 ESCAPE '\\') ORDER BY id",
      )
      .bind(pattern)
      .all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(['lead_a']);
  });

  it('batch() executes statements sequentially and reports success per statement', async () => {
    const results = await d1.batch([
      d1.prepare('INSERT INTO login_attempts (key, fails) VALUES (?, ?)').bind('k1', 1),
      d1.prepare('INSERT INTO login_attempts (key, fails) VALUES (?, ?)').bind('k2', 2),
    ]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    const { results: rows } = await d1
      .prepare('SELECT key FROM login_attempts ORDER BY key')
      .all<{ key: string }>();
    expect(rows.map((r) => r.key)).toEqual(['k1', 'k2']);
  });
});
