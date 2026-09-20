/**
 * In-memory fakes of the project's storage interfaces, for unit and integration tests.
 *
 * These implement `SqlDatabase`, `KeyValueStore` and `ObjectBucket` from `src/lib/runtime/types.ts`
 * with no network and no Cloudflare â€” they replace the old `getPlatformProxy()` local D1/KV/R2 that
 * the pre-migration tests used. The application code under test is unchanged; only the concrete
 * store it is handed differs, exactly as in production (Neon/Blobs) vs. test (these).
 *
 * - `fakeSqlDatabase()` runs against Node's built-in `node:sqlite`, translating the Postgres `$n`
 *   placeholders the adapter emits back to SQLite `?` so the real application SQL executes. The
 *   `db/schema.sql` DDL is Postgres-flavoured but its subset here (TEXT/INTEGER, PRIMARY KEY, UNIQUE,
 *   functional LOWER(email) index, ON CONFLICT ... DO UPDATE) is accepted by SQLite too, so the same
 *   schema and the same statements exercise the same behaviour.
 * - `fakeKeyValueStore()` is a Map with TTL honoured on read (lazy expiry), matching the Blobs KV
 *   adapter.
 * - `fakeObjectBucket()` is a Map of key â†’ { bytes, metadata }, matching the Blobs object adapter.
 */

import { DatabaseSync } from 'node:sqlite';

import type {
  KeyValueStore,
  ObjectBucket,
  ObjectListResult,
  ObjectPutOptions,
  SqlDatabase,
  SqlPreparedStatement,
  StoredObjectBody,
} from '@/lib/runtime/types';

/* -------------------------------------------------------------------------- */
/* SQL â€” node:sqlite behind the SqlDatabase interface                          */
/* -------------------------------------------------------------------------- */

/** Convert the adapter's `$n` placeholders back to SQLite positional `?`. */
function toSqlitePlaceholders(query: string): { text: string; order: number[] } {
  const order: number[] = [];
  const text = query.replace(/\$(\d+)/g, (_match, index: string) => {
    order.push(Number.parseInt(index, 10));
    return '?';
  });
  return { text, order };
}

class FakeStatement implements SqlPreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    return new FakeStatement(this.db, this.query, values);
  }

  /** Reorder bound values to match the `$n` order, and coerce to SQLite-bindable types. */
  private prepared(): { stmt: ReturnType<DatabaseSync['prepare']>; params: unknown[] } {
    // With no bound values the SQL is fully inlined; converting `$n` would corrupt string literals
    // that happen to contain `$1` (e.g. a PBKDF2 hash), so pass it through untouched.
    if (this.values.length === 0) {
      return { stmt: this.db.prepare(this.query), params: [] };
    }
    const { text, order } = toSqlitePlaceholders(this.query);
    const params =
      order.length > 0
        ? order.map((n) => this.coerce(this.values[n - 1]))
        : this.values.map((v) => this.coerce(v));
    return { stmt: this.db.prepare(text), params };
  }

  private coerce(value: unknown): string | number | bigint | null | Uint8Array {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    return JSON.stringify(value);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { stmt, params } = this.prepared();
    const row = stmt.get(...(params as never[]));
    return (row as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const { stmt, params } = this.prepared();
    return { results: stmt.all(...(params as never[])) as T[] };
  }

  async run(): Promise<{ success: boolean }> {
    const { stmt, params } = this.prepared();
    stmt.run(...(params as never[]));
    return { success: true };
  }
}

class FakeSqlDatabase implements SqlDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): SqlPreparedStatement {
    return new FakeStatement(this.db, query);
  }

  async batch(statements: SqlPreparedStatement[]): Promise<{ success: boolean }[]> {
    const out: { success: boolean }[] = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

/** A fresh in-memory SQL database with the application schema applied. */
export function fakeSqlDatabase(schema?: string): SqlDatabase {
  const db = new DatabaseSync(':memory:');
  if (schema !== undefined) {
    for (const statement of schema
      // Strip `--` comments to end-of-line wherever they appear (trailing comments in the leads
      // migration contain semicolons, which would otherwise split a statement in half).
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      db.exec(statement);
    }
  }
  return new FakeSqlDatabase(db);
}

/* -------------------------------------------------------------------------- */
/* KV â€” Map with lazy TTL behind the KeyValueStore interface                   */
/* -------------------------------------------------------------------------- */

export function fakeKeyValueStore(): KeyValueStore {
  const map = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string): string | null => {
    const entry = map.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    async get(key: string, type: 'text' | 'json' = 'text'): Promise<unknown> {
      const value = live(key);
      if (value === null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      }
      return value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      map.set(key, {
        value,
        expiresAt:
          options?.expirationTtl === undefined ? null : Date.now() + options.expirationTtl * 1000,
      });
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<{
      keys: { name: string }[];
      list_complete: boolean;
    }> {
      const prefix = options?.prefix ?? '';
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as KeyValueStore;
}

/* -------------------------------------------------------------------------- */
/* Object bucket â€” Map behind the ObjectBucket interface                       */
/* -------------------------------------------------------------------------- */

export function fakeObjectBucket(): ObjectBucket {
  const map = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    }
  >();
  return {
    async put(
      key: string,
      value: Uint8Array | ArrayBuffer,
      options?: ObjectPutOptions,
    ): Promise<void> {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      map.set(key, {
        bytes,
        ...(options?.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
        ...(options?.customMetadata === undefined
          ? {}
          : { customMetadata: options.customMetadata }),
      });
    },
    async get(key: string): Promise<StoredObjectBody | null> {
      const entry = map.get(key);
      if (entry === undefined) return null;
      const bytes = entry.bytes;
      return {
        ...(entry.httpMetadata === undefined ? {} : { httpMetadata: entry.httpMetadata }),
        ...(entry.customMetadata === undefined ? {} : { customMetadata: entry.customMetadata }),
        httpEtag: `"${String(bytes.byteLength)}"`,
        size: bytes.byteLength,
        arrayBuffer: () =>
          Promise.resolve(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ),
        body: new Blob([
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        ]).stream(),
      };
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async list(options?: { prefix?: string }): Promise<ObjectListResult> {
      const prefix = options?.prefix ?? '';
      const objects = [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}
