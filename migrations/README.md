# D1 (SQLite) migrations

These are the **Cloudflare D1** schema migrations for New Galaxy Furniture, bound as `DB` in
`wrangler.toml` (`migrations_dir = "migrations"`). They are the project's original, canonical D1
migrations and predate the Netlify work; `db/schema.sql` is the PostgreSQL/Neon translation of this
exact schema, kept in sync for the Netlify deployment.

> **Status: not yet applied.** Nothing in this directory has been applied to a real D1 database. The
> Cloudflare target is wired and builds, but applying migrations to a remote D1 database and
> provisioning an admin account are manual steps that require a Cloudflare account and are listed
> below. Cloudflare preview/local resources are treated as **empty**; no production data is migrated.

## Files (applied in filename order by `wrangler d1 migrations apply`)

| File | Tables | Notes |
|------|--------|-------|
| `0001_admin.sql` | `admin_users`, `login_attempts` | Credentials + login-abuse state. `LOWER(email)` unique index; `login_attempts.key` is a hash, never a raw email/IP. |
| `0002_leads.sql` | `leads` | Enquiry personal data; `status, created_at DESC` and `created_at DESC` indexes. |
| `0003_events.sql` | `event_daily`, `search_queries` | Daily analytics aggregates only (no per-visitor rows); composite PKs are the upsert targets. |

Every statement is `CREATE TABLE/INDEX IF NOT EXISTS`, so the set is idempotent and safe to re-run.

> **Note on the earlier `0001_init.sql`.** A consolidated `0001_init.sql` was briefly added during
> the migration work and has been removed: it duplicated these three files and shared the `0001_`
> prefix with `0001_admin.sql`, which would make D1's migration ordering ambiguous. The three split
> files above are the single source of truth for the D1 schema.

## Apply the migrations (reference — requires a Cloudflare account; not run here)

```sh
# Local D1 (Miniflare) — safe, writes to a local SQLite file under .wrangler/, no network:
npx wrangler d1 migrations apply DB --local

# A real (remote) D1 database — only after the database exists and you have approved it:
npx wrangler d1 migrations apply DB --remote
```

The remote apply requires a real `database_id` in `wrangler.toml` (currently a placeholder — see the
root audit report). Do not run `--remote` against production data without an explicit decision.

## Schema parity: PostgreSQL (`db/schema.sql`) ↔ SQLite/D1 (these files)

Identical logical schema; only the dialect differs. Verified structurally (same tables, columns,
indexes, constraints) and exercised by the unit suite, which loads the application SQL against an
in-memory SQLite database (`tests/fixtures/runtime.ts`).

| Concern | Postgres (`db/schema.sql`) | SQLite/D1 (here) | Behaviour-preserving because |
|---|---|---|---|
| Text / integer columns | `TEXT` / `INTEGER` | identical | both unbounded `TEXT`, whole-number `INTEGER` |
| Timestamps | `TEXT` ISO-8601 | identical | lexicographic range compares (`created_at >= '...'`) are correct for zero-padded ISO on both |
| Case-insensitive email | `CREATE UNIQUE INDEX ... (LOWER(email))` | identical | both support expression indexes |
| Descending index | `(status, created_at DESC)` / `(created_at DESC)` | identical | both honour per-column `DESC` |
| Upsert | `ON CONFLICT (...) DO UPDATE SET x = excluded.x` | identical | same syntax + `excluded.` pseudo-table on both |
| Nullable integer default | `spam_score INTEGER DEFAULT 0` | identical | read path tolerates NULL (`spam_score ?? 0`) |

No Postgres-only types (`SERIAL`, `JSONB`, `TIMESTAMPTZ`, `UUID`, `BOOLEAN`) are used, which is why
the two dialects stay this close.

## Admin-account provisioning

`scripts/seed-admin.ts` creates the first admin account. It is currently **Netlify/Neon-specific**:
it connects with `@netlify/neon` and inserts with Postgres `$1..$6` placeholders. The security model
around it is platform-neutral — it imports the one runtime `hashPassword` (PBKDF2) from
`src/lib/auth/password.ts`, never ships a default password, never echoes input, and relies on the
`LOWER(email)` unique index for "one account per address".

**On Cloudflare, provisioning is a documented manual step (not yet automated):**

1. Apply the migrations so `admin_users` exists (local or remote, above).
2. Create the account. Two safe options, neither of which fabricates or prints a password:
   - **Adapt the seed script for D1** (recommended): a small variant that reads the password the same
     way (raw-mode TTY, no echo, no flag/env fallback), hashes with the same `hashPassword`, and
     writes with `wrangler d1 execute DB --command "INSERT INTO admin_users (...) VALUES (?, ?, ?, ?, 'ACTIVE', ?)"`
     using bound parameters. This keeps the existing security guarantees.
   - **One-off interactive insert**: hash a password locally with `hashPassword`, then
     `wrangler d1 execute DB --local|--remote` the parameterised INSERT. Never pass the plaintext on
     the command line.
3. The password is never committed, never logged, and stored only in the operator's password manager.

> This gap (a D1-targeted seed path) is intentionally left as a documented manual step rather than
> implemented blind, because it touches credential storage and should be reviewed before use.
