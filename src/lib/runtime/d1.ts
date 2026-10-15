/**
 * SQL database adapter — Cloudflare D1 behind the project's `SqlDatabase` interface.
 *
 * This is the Cloudflare counterpart of `src/lib/runtime/neon.ts`. The application's data modules
 * (`leads/store`, `analytics/*`, `auth/users`, `auth/rate-limit`) are written against
 * `SqlDatabase.prepare(sql).bind(...).first()/all()/run()`, and this module is the one place that
 * turns that surface into D1's own `D1Database.prepare(sql).bind(...).first()/all()/run()` calls.
 * Nothing else in the codebase imports `@cloudflare/workers-types` for the database.
 *
 * **Placeholders — why nothing is rewritten here.** The data modules use two placeholder styles,
 * never mixed within one statement:
 *   - sequential `?` (most statements), bound left to right;
 *   - explicit `?1` (the leads search, which reuses `?1` five times and is rendered with every
 *     other placeholder numbered too — see `leads/store.ts#numbered`).
 * D1's SQLite engine accepts BOTH forms natively: a bare `?` takes the next position, and `?NNN`
 * binds to the Nth bound argument. The Neon adapter has to convert these to Postgres `$n`; D1 does
 * not, so the statement text is passed through unchanged. Rewriting it would be the bug, not the
 * fix — `?1` must stay `?1` for the five-way reuse in the leads search to bind to one argument.
 *
 * **Dialect.** The SQL the modules emit is the SQLite dialect these statements were originally
 * written for (`ON CONFLICT(key) DO UPDATE SET x = excluded.x`, `LIKE ?1 ESCAPE '\'`, `COALESCE`,
 * `COUNT(*) AS total`), so no statement text is adjusted. The D1 schema lives in `migrations/`.
 *
 * **Shape mapping.** D1's `.run()` returns a `D1Result` with a `.success` flag and metadata; the
 * project's contract only reads `{ success }`, so the rest is dropped. `.all()` returns
 * `{ results, success, meta }`; the project's contract is `{ results }`. `.first()` returns the row
 * or `null`, which matches directly.
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

import type { SqlDatabase, SqlPreparedStatement } from './types';

class D1PreparedStatementAdapter implements SqlPreparedStatement {
  constructor(private readonly statement: D1PreparedStatement) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    // D1's `.bind()` returns a new bound statement, matching the project's prepared-statement
    // contract where `.bind()` yields a bound statement rather than mutating in place.
    return new D1PreparedStatementAdapter(this.statement.bind(...values));
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    // D1 `.first()` with no column name returns the whole first row, or null when there are none.
    return await this.statement.first<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const result = await this.statement.all<T>();
    // Narrow D1's richer `{ results, success, meta }` to the project's `{ results }` contract.
    return { results: result.results };
  }

  async run(): Promise<{ success: boolean }> {
    const result = await this.statement.run();
    return { success: result.success };
  }
}

class D1DatabaseAdapter implements SqlDatabase {
  constructor(private readonly db: D1Database) {}

  prepare(query: string): SqlPreparedStatement {
    // The statement text is passed to D1 verbatim; see the placeholder note in the file header.
    return new D1PreparedStatementAdapter(this.db.prepare(query));
  }

  async batch(statements: SqlPreparedStatement[]): Promise<{ success: boolean }[]> {
    // The project's `batch` contract is "execute several prepared writes and report success per
    // statement". The one caller (the analytics rollup flush) upserts idempotently-by-addition, so
    // executing the statements in sequence is correct and safe under retry — the same semantics the
    // Neon adapter provides. D1 does offer a native `db.batch()` that runs inside one implicit
    // transaction, but these adapter statements are the project's own type, not `D1PreparedStatement`,
    // so they cannot be handed to it without re-preparing; sequential `.run()` keeps the two SQL
    // adapters behaviourally identical, which is what the shared tests assert.
    const results: { success: boolean }[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

/** Build a `SqlDatabase` from a D1 binding (`env.DB`). */
export function createD1Database(db: D1Database): SqlDatabase {
  return new D1DatabaseAdapter(db);
}
