/**
 * SQL database adapter — Netlify Neon Postgres behind the project's `SqlDatabase` interface.
 *
 * The application's data modules (`leads/store`, `analytics/*`, `auth/users`, `auth/rate-limit`)
 * are written against `SqlDatabase.prepare(sql).bind(...).first()/all()/run()`. This module is the
 * one place that turns that surface into Neon's `sql(text, params)` HTTP calls, so nothing else in
 * the codebase imports a database driver or knows the store is Postgres.
 *
 * **Placeholders.** The modules use two placeholder styles, never mixed within one statement:
 *   - sequential `?` (most statements), bound left to right;
 *   - explicit `?1`, `?2` (the leads search, which reuses `?1` five times).
 * Postgres wants `$1`, `$2`. `toPositional` converts either style to `$n` and returns the argument
 * order, so `.bind(...)` values map to the right `$n` regardless of style.
 *
 * **Dialect.** The SQL already written is Postgres-compatible: `ON CONFLICT (...) DO UPDATE SET
 * x = excluded.x`, `LIKE $1 ESCAPE '\'`, `COALESCE`, `COUNT(*) AS total`, `SUM(count)` all parse on
 * both engines, so no statement text is rewritten here beyond the placeholder mapping. The schema
 * (see `db/schema.sql`) uses Postgres column types; the query text does not depend on them.
 *
 * Neon's driver runs each `sql(...)` as a single statement over HTTPS — there is no session — which
 * matches how these modules use the database (one statement per call, plus an application-level
 * `batch` that simply awaits several in sequence).
 */

import { neon } from '@netlify/neon';

import type { SqlDatabase, SqlPreparedStatement } from './types';

type NeonSql = ReturnType<typeof neon>;

/** Convert `?`/`?n` placeholders to `$n`, returning the SQL and the count of positions. */
export function toPositional(query: string): string {
  // If the statement uses explicit indices (`?1`), map each `?n` to `$n` verbatim.
  if (/\?\d/.test(query)) {
    return query.replace(/\?(\d+)/g, (_match, index: string) => `$${index}`);
  }
  // Otherwise assign sequential indices to each bare `?`.
  let index = 0;
  return query.replace(/\?/g, () => {
    index += 1;
    return `$${String(index)}`;
  });
}

class NeonPreparedStatement implements SqlPreparedStatement {
  private readonly text: string;
  private readonly values: unknown[];

  constructor(
    private readonly sql: NeonSql,
    query: string,
    values: unknown[] = [],
  ) {
    this.text = toPositional(query);
    this.values = values;
  }

  bind(...values: unknown[]): SqlPreparedStatement {
    // Rebuild rather than mutate, matching the original prepared-statement contract where
    // `.bind()` returns a bound statement.
    return new NeonPreparedStatement(this.sql, this.rawText(), values);
  }

  /** The original `?`-style text is not retained; `bind` re-wraps the already-converted text,
   *  which is safe because `toPositional` is idempotent on `$n`. */
  private rawText(): string {
    return this.text;
  }

  private async query<T>(): Promise<T[]> {
    // Neon's `query()` form: sql.query(queryString, params). Returns the rows directly.
    const rows = (await this.sql.query(this.text, this.values)) as unknown as T[];
    return rows;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = await this.query<T>();
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = await this.query<T>();
    return { results: rows };
  }

  async run(): Promise<{ success: boolean }> {
    await this.query();
    return { success: true };
  }
}

class NeonDatabase implements SqlDatabase {
  constructor(private readonly sql: NeonSql) {}

  prepare(query: string): SqlPreparedStatement {
    return new NeonPreparedStatement(this.sql, query);
  }

  async batch(statements: SqlPreparedStatement[]): Promise<{ success: boolean }[]> {
    // The Neon HTTP driver has no interactive transaction; the one caller (analytics flush) upserts
    // idempotently-by-addition, so sequential execution is correct and safe under retry.
    const results: { success: boolean }[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

/**
 * Build a `SqlDatabase` from a connection string.
 *
 * When `connectionString` is omitted, `@netlify/neon` reads `NETLIFY_DATABASE_URL` — the variable
 * Netlify's Neon integration sets automatically — so a deployed function needs no explicit wiring.
 */
export function createNeonDatabase(connectionString?: string): SqlDatabase {
  const sql = connectionString === undefined ? neon() : neon(connectionString);
  return new NeonDatabase(sql);
}
