/**
 * `tsx scripts/seed-admin-d1.ts` — one-time creation of the first admin account in the remote
 * Cloudflare D1 database `ngf-content`, via the documented D1 REST API with BOUND parameters.
 *
 * This is the Cloudflare D1 counterpart of `scripts/seed-admin.ts` (which targets Neon/Postgres and
 * is left untouched). It exists because `wrangler d1 execute` offers only `--command`/`--file` — no
 * parameter binding — which would force the password hash onto a command line or into a `.sql` file.
 * The D1 REST API (`POST /accounts/{account}/d1/database/{database}/query`) accepts `{ sql, params }`
 * with SQLite `?` placeholders bound server-side, so no secret ever appears in argv, an env var, a
 * file, or shell history. The hash travels only inside the HTTPS request body and is never logged.
 *
 * Security properties this script is the enforcement point for:
 *
 * - **No secret via CLI args or environment.** The admin password AND the Cloudflare API token are
 *   both read from the TTY in raw mode with no echo. There is no `--password`/`--token` flag and no
 *   environment-variable fallback for either; without an interactive TTY the script exits non-zero.
 * - **The runtime hash function is the only hash function.** It imports `hashPassword` from
 *   `src/lib/auth/password.ts` unchanged (PBKDF2-HMAC-SHA-256, 600k iterations, `pbkdf2$sha256$...`),
 *   so a seeded credential verifies under the exact parameters the login path accepts.
 * - **Nothing sensitive is logged.** The plaintext lives in one local variable, is passed to
 *   `hashPassword`, and is dropped. The hash goes only into the bound `params` array. The token is
 *   put only on the `Authorization` header of the request. None of plaintext, hash, token,
 *   Authorization header, or request/response bodies are ever printed.
 * - **Bound parameters only.** Every value reaches D1 as a `?`-bound parameter; this file never
 *   concatenates a value into SQL.
 * - **One account per address, never an overwrite.** A case-insensitive `SELECT` refuses a duplicate
 *   up front, and the `LOWER(email)` unique index from migration 0001 is the final safeguard. There
 *   is no `UPDATE`/upsert anywhere here.
 * - **Writes only to the verified database.** The account id (prompted) is format-checked and the
 *   D1 database id is pinned to the known `ngf-content` id; a mismatch aborts before any write.
 *
 * Design: Admin Authentication → Credential storage. Requirements: 10.4, 10.13, 10.18, 25.3, 25.16.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import { hashPassword } from '../src/lib/auth/password';
import { ROLES } from '../src/lib/auth/permissions';

/** The exact remote D1 database the first admin must be created in (binding `DB` → `ngf-content`). */
const EXPECTED_DATABASE_ID = 'deff371f-d6e6-4172-ba16-4b4f9f52d5fa';
/** Cloudflare account ids are 32 lowercase hex characters. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const MIN_PASSWORD_LENGTH = 12;
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

function fail(message: string): never {
  process.stderr.write(`seed-admin-d1: ${message}\n`);
  process.exit(1);
}

/** A single visible line of input (for non-secret fields: email, role, account id). */
async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * A line of input with NO echo at all. Raw mode; Ctrl-C handled explicitly. Used for both the admin
 * password and the Cloudflare API token so neither is ever displayed, scrolled back, or logged.
 * Copied self-contained from `scripts/seed-admin.ts` so that script is not modified.
 */
async function promptSecret(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    fail('a TTY is required — this script will not read a secret from a pipe or a file');
  }

  // The data listener is declared out here so `finally` can always remove it, even if the read
  // rejects. `ctrlC` records that the user aborted so cleanup happens in `finally` (raw mode off,
  // stdin paused, listener removed) BEFORE the process exits — never leaving the terminal in raw
  // mode. No input is ever echoed; nothing is logged.
  let onData: ((chunk: string) => void) | undefined;
  let ctrlC = false;
  try {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    return await new Promise<string>((resolve) => {
      let value = '';
      onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') {
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            // Ctrl-C: resolve now; the `finally` block restores the terminal, then we exit below.
            ctrlC = true;
            resolve('');
            return;
          }
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          if (char >= ' ') value += char;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    // Runs on every path — normal return, Ctrl-C, or a thrown error — so the terminal is always
    // restored and the temporary listener is always removed.
    if (onData !== undefined) stdin.removeListener('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
    if (ctrlC) process.exit(130);
  }
}

/**
 * Minimal shape of the D1 REST query response this script relies on.
 *
 * The envelope carries a top-level `success` plus a `result` array, one entry per statement. Each
 * entry has its OWN `success` and a `meta` object; for a write, `meta.changes` (and/or
 * `meta.rows_written`) reports how many rows the statement affected. Both inner fields are modelled
 * as optional because a confirmation must FAIL CLOSED when the metadata is missing or unexpected
 * rather than assume the write happened.
 */
interface D1StatementResult {
  success?: boolean;
  results?: unknown[];
  meta?: { changes?: number; rows_written?: number };
}
interface D1QueryResponse {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: D1StatementResult[];
}

/**
 * Run one SQL statement against the remote D1 database with bound parameters.
 *
 * The token is placed only on the Authorization header; `sql`/`params` go in the JSON body. On any
 * non-OK HTTP status or `success: false`, a generic, non-sensitive message is thrown — the raw
 * response body is never surfaced, because it could echo back request detail.
 */
async function d1Query(
  accountId: string,
  databaseId: string,
  token: string,
  sql: string,
  params: (string | null)[],
): Promise<D1QueryResponse> {
  const url = `${CF_API_BASE}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
  } catch {
    // A network-level failure. No request detail is included.
    fail('could not reach the Cloudflare D1 API (network error)');
  }

  if (!response.ok) {
    // Map a few expected statuses to actionable, non-sensitive hints.
    if (response.status === 401 || response.status === 403) {
      fail(
        'the API token was rejected (401/403). It needs Account → D1 → Edit on this account. ' +
          'No account was created.',
      );
    }
    if (response.status === 404) {
      fail('the account id or database id was not found (404). No account was created.');
    }
    fail(`the D1 API returned HTTP ${String(response.status)}. No account was created.`);
  }

  let body: D1QueryResponse;
  try {
    body = (await response.json()) as D1QueryResponse;
  } catch {
    fail('the D1 API returned a response that could not be parsed. No account was created.');
  }

  if (!body.success) {
    // D1 reports a unique-constraint violation here when the email already exists (the final
    // safeguard behind the pre-check). Report it as the intended outcome, without echoing the body.
    const code = body.errors?.[0]?.message ?? '';
    if (/unique|constraint/i.test(code)) {
      fail(
        'that email is already registered (unique index rejected the insert). ' +
          'The existing account was NOT modified.',
      );
    }
    fail('the D1 API reported the query was unsuccessful. No account was created.');
  }

  return body;
}

/**
 * Confirm an INSERT unambiguously wrote exactly one row.
 *
 * Returns true ONLY when the statement's own `success` is true AND its metadata reports exactly one
 * row changed/written. Anything else — a missing `result` entry, missing `meta`, a count that is
 * not exactly 1, or `success` not strictly true — is treated as AMBIGUOUS and returns false, so the
 * caller can refuse to claim success. The INSERT is never retried on an ambiguous result.
 */
function insertedExactlyOneRow(body: D1QueryResponse): boolean {
  const statement = body.result?.[0];
  if (statement === undefined || statement.success !== true) return false;
  const meta = statement.meta;
  if (meta === undefined) return false;
  const changed = meta.changes ?? meta.rows_written;
  return changed === 1;
}

async function main(): Promise<void> {
  process.stdout.write(
    'Create the first admin account in the REMOTE Cloudflare D1 database `ngf-content`.\n' +
      'The password and API token are read without echo and are never logged or stored.\n\n',
  );

  // --- Target database -------------------------------------------------------
  const accountIdRaw = await prompt('Cloudflare account id (32 hex): ');
  const accountId = accountIdRaw.trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    fail('that is not a valid Cloudflare account id (expected 32 hexadecimal characters)');
  }

  // The database id is pinned, not prompted: this script provisions exactly one known database.
  const databaseId = EXPECTED_DATABASE_ID;

  // --- Account fields --------------------------------------------------------
  const emailRaw = await prompt('Admin email: ');
  const email = emailRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 254) {
    fail('that does not look like an email address');
  }

  const roleRaw = (await prompt(`Role [${ROLES.join('|')}] (default owner): `)).trim();
  const role = roleRaw === '' ? 'owner' : roleRaw;
  if (!(ROLES as readonly string[]).includes(role)) {
    fail(`role must be one of ${ROLES.join(', ')}`);
  }

  // --- Credentials (no echo) -------------------------------------------------
  const token = await promptSecret('Cloudflare API token (Account → D1 → Edit, not echoed): ');
  if (token.trim() === '') fail('an API token is required');

  const password = await promptSecret(`Password (min ${String(MIN_PASSWORD_LENGTH)}, not echoed): `);
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);
  }
  const confirm = await promptSecret('Confirm password: ');
  if (password !== confirm) fail('passwords did not match');

  // --- Pre-check: refuse a duplicate (case-insensitive), bound parameter ------
  const existing = await d1Query(
    accountId,
    databaseId,
    token.trim(),
    'SELECT id FROM admin_users WHERE LOWER(email) = ? LIMIT 1',
    [email],
  );
  const alreadyThere = (existing.result?.[0]?.results?.length ?? 0) > 0;
  if (alreadyThere) {
    fail(
      'an account with that email already exists. This script never overwrites or updates an ' +
        'existing account — nothing was changed.',
    );
  }

  // --- Confirmation step (shows only normalized email and role) --------------
  const proceed = (
    await prompt(`\nAbout to create admin account:\n  email: ${email}\n  role:  ${role}\nType "yes" to proceed: `)
  )
    .trim()
    .toLowerCase();
  if (proceed !== 'yes') fail('aborted at confirmation; nothing was written');

  // The one place the plaintext is used. After this line nothing downstream can recover it.
  const passwordHash = await hashPassword(password);

  const id = `usr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  // --- Insert, all values bound as ? parameters ------------------------------
  const inserted = await d1Query(
    accountId,
    databaseId,
    token.trim(),
    'INSERT INTO admin_users (id, email, password_hash, role, status, created_at) ' +
      "VALUES (?, ?, ?, ?, 'ACTIVE', ?)",
    [id, email, passwordHash, role, createdAt],
  );

  // Only claim success when the API unambiguously confirms exactly one new row. An ambiguous result
  // (missing/unexpected metadata, or a count other than 1) is NOT a success and is NOT retried: the
  // operator is told to verify manually, so a silent partial state can never read as "done".
  if (!insertedExactlyOneRow(inserted)) {
    fail(
      'the insert did not unambiguously confirm exactly one new row. No success is claimed and the ' +
        'insert was NOT retried — verify the admin_users table manually before trying again.',
    );
  }

  process.stdout.write(
    `\nCreated ${role} account ${email} (${id}) in the remote D1 database ngf-content.\n` +
      'The password was not printed and is not recoverable — store it in your password manager now.\n',
  );
}

await main();
