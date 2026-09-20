/**
 * Storage interface types — Netlify-native, defined here rather than imported.
 *
 * These are the *shapes* the application's stores are written against: a small SQL
 * database interface, a key-value interface, and an object-bucket interface. They were
 * historically the shapes of Cloudflare's `D1Database`, `KVNamespace` and `R2Bucket`
 * bindings, because the application ran on Workers. The application no longer runs on
 * Workers and imports nothing from `@cloudflare/workers-types`; these interfaces are now
 * the project's own, and the concrete implementations behind them are
 * Neon Postgres (`SqlDatabase`) and Netlify Blobs (`KeyValueStore`, `ObjectBucket`).
 *
 * Keeping the same method surface is a deliberate, contained decision: every store, query
 * and auth module already takes one of these as a parameter, so preserving the surface let
 * the migration swap the *implementation* under ~30 call sites without rewriting their SQL,
 * their key logic, or their tests. The names are generic on purpose — nothing here is
 * Cloudflare-specific, and nothing here imports a Cloudflare type.
 *
 * Design: Architecture → Storage. Netlify migration.
 */

/* -------------------------------------------------------------------------- */
/* SQL database (Neon Postgres, via the D1-shaped adapter)                    */
/* -------------------------------------------------------------------------- */

/** A prepared statement with positional `?` placeholders, bound then executed. */
export interface SqlPreparedStatement {
  /** Bind positional parameters, left to right. Returns a bound statement. */
  bind(...values: unknown[]): SqlPreparedStatement;
  /** The first row, typed by the caller, or `null` when there are none. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** Every row, under `results`, matching the historical `.all()` shape. */
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  /** Execute a write; the return is ignored by every call site. */
  run(): Promise<{ success: boolean }>;
}

/** A minimal SQL database: prepare a statement, optionally batch several. */
export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  /** Execute several prepared writes; used by the analytics rollup flush. */
  batch(statements: SqlPreparedStatement[]): Promise<{ success: boolean }[]>;
}

/* -------------------------------------------------------------------------- */
/* Key-value store (Netlify Blobs, via the KV-shaped adapter)                 */
/* -------------------------------------------------------------------------- */

export interface KeyValuePutOptions {
  /** Seconds until the entry expires. Emulated by storing an expiry and lazy-deleting. */
  expirationTtl?: number;
}

/** Text/JSON key-value access with a TTL, backed by a Netlify Blobs store. */
export interface KeyValueStore {
  get(key: string, type?: 'text'): Promise<string | null>;
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: KeyValuePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys under a prefix, following the cursor to the end. */
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Object bucket (Netlify Blobs, via the R2-shaped adapter)                   */
/* -------------------------------------------------------------------------- */

/** HTTP metadata stored alongside an object (content type, cache policy). */
export interface ObjectHttpMetadata {
  contentType?: string;
  cacheControl?: string;
}

/** A stored object handle: its metadata, and its bytes on demand. */
export interface StoredObjectBody {
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
  /** ETag for conditional responses; opaque. */
  httpEtag: string;
  /** The stored object's size in bytes. */
  size: number;
  /** The bytes as an ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The bytes as a stream, for a passthrough response body. */
  body: ReadableStream | null;
}

export interface ObjectPutOptions {
  httpMetadata?: ObjectHttpMetadata;
  customMetadata?: Record<string, string>;
}

export interface ObjectListItem {
  key: string;
}

export interface ObjectListResult {
  objects: ObjectListItem[];
  truncated: boolean;
  cursor?: string;
}

/** An object store: put/get/delete/list, backed by a Netlify Blobs store. */
export interface ObjectBucket {
  put(key: string, value: Uint8Array | ArrayBuffer, options?: ObjectPutOptions): Promise<void>;
  get(key: string): Promise<StoredObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<ObjectListResult>;
}
