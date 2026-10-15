/**
 * `npm run db:migrate` â€” apply `db/schema.sql` to the Neon Postgres database.
 *
 * Reads the connection string from `NETLIFY_DATABASE_URL` (the variable Netlify's Neon integration
 * sets) or `DATABASE_URL`, splits the schema into individual statements, and executes each over the
 * Neon HTTP driver. Every statement is `CREATE TABLE/INDEX ... IF NOT EXISTS`, so the script is
 * idempotent and safe against a fresh database or an existing one â€” it never drops or alters data.
 *
 * Run locally against your Neon branch:
 *   NETLIFY_DATABASE_URL="postgres://..." npm run db:migrate
 *
 * On Netlify the same variable is present in the build/function environment, so this can also run
 * as a one-off from `netlify dev` or a deploy step. It performs no destructive operation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { neon } from '@netlify/neon';

const SCHEMA_PATH = fileURLToPath(new URL('../db/schema.sql', import.meta.url));

/**
 * Remove a `--` line comment from a single line, to end of line.
 *
 * Only a `--` that is OUTSIDE a single-quoted string begins a comment, so a literal that
 * legitimately contains `--` (or a `;`) is never damaged. A `''` escaped-quote inside a string
 * toggles the quote state twice and therefore nets out correctly.
 */
function stripLineComment(line: string): string {
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '-' && line[i + 1] === '-') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Split SQL into executable statements: strip comments, split on `;`, drop blanks.
 *
 * Comments are stripped FIRST, then the text is split on `;`. The previous version removed only
 * whole-line comments (lines beginning with `--`), which left *inline trailing* comments attached
 * to a column line, e.g. `key TEXT PRIMARY KEY, -- 'email…'`. The Neon HTTP driver then received a
 * statement whose remainder was commented out, so `CREATE TABLE …(` arrived unterminated and
 * Postgres answered `syntax error at end of input`. `stripLineComment` is quote-aware, so inline
 * trailing comments are removed while quoted literals are preserved byte for byte. `db/schema.sql`
 * uses only `--` line comments and simple single-quoted literals; C-style block comments are not
 * used and are intentionally out of scope.
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map(stripLineComment)
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main(): Promise<void> {
  const url = process.env.NETLIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    console.error(
      'db:migrate â€” set NETLIFY_DATABASE_URL (or DATABASE_URL) to your Neon connection string.',
    );
    process.exitCode = 1;
    return;
  }

  const sql = neon(url);
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const parts = statements(schema);

  console.log(`db:migrate â€” applying ${String(parts.length)} statement(s) to Neon...`);
  for (const [index, statement] of parts.entries()) {
    // `sql(text, params)` runs a single statement; DDL takes no parameters.
    await sql.query(statement, []);
    const firstLine = statement.split('\n')[0] ?? statement;
    console.log(`  [${String(index + 1)}/${String(parts.length)}] ${firstLine.slice(0, 72)}`);
  }
  console.log('db:migrate â€” done. Schema is present and up to date.');
}

await main();
