-- db/schema.sql — PostgreSQL schema for New Galaxy Furniture (Neon / Netlify DB).
--
-- This is the Postgres equivalent of the three SQLite/D1 migrations that the application used on
-- Cloudflare (migrations/0001_admin.sql, 0002_leads.sql, 0003_events.sql). Every table, column,
-- index, constraint and semantic is preserved; only the dialect changed. It is idempotent
-- (`IF NOT EXISTS`) and safe to run against a fresh Neon database or re-run against an existing one.
--
-- What changed from SQLite → Postgres, and why it is behaviour-preserving:
--   * `TEXT` stays `TEXT` (Postgres TEXT is unbounded, same as SQLite).
--   * `INTEGER` stays `INTEGER`; counters and `fails` are whole numbers.
--   * Timestamps remain `TEXT` holding ISO-8601 strings, exactly as the application writes and
--     compares them (`created_at >= '2026-03-14T00:00:00.000Z'` is a lexicographic comparison that
--     is correct for zero-padded ISO instants on both engines). Keeping the column type identical
--     avoids any implicit-cast difference in the range queries the leads/analytics code runs.
--   * `LOWER(email)` functional unique index is native to Postgres.
--   * `ON CONFLICT (...) DO UPDATE SET x = excluded.x` is identical syntax on both engines, so the
--     analytics upserts and the login-attempts upsert are unchanged.
--   * `spam_score INTEGER DEFAULT 0` — NULL is still tolerated by the read path (`spam_score ?? 0`).
--
-- Run with:  npm run db:migrate    (see scripts/db-migrate.ts)

-- 0001 — admin credentials and login abuse state -----------------------------

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,           -- stored lowercased
  password_hash TEXT NOT NULL,                  -- pbkdf2$sha256$600000$<b64 salt>$<b64 key>
  role          TEXT NOT NULL DEFAULT 'owner',  -- owner | editor | viewer
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DISABLED
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Byte-exact UNIQUE(email) is not "one account per address": every write path lowercases before
-- storing, and this functional index makes that a database guarantee, not a convention.
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx ON admin_users (LOWER(email));
CREATE INDEX IF NOT EXISTS admin_users_status_idx ON admin_users (status);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,                -- 'email:<sha256 hex>' or 'ip:<sha256 hex>'
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- 0002 — enquiry leads (personal data; never in the content repository) -------

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,               -- server clock, ISO 8601
  type         TEXT NOT NULL,               -- QUICK_ENQUIRE|CALLBACK|QUOTE|CUSTOM|CONTACT
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,               -- canonical E.164
  message      TEXT NOT NULL,
  product_slug TEXT,
  product_name TEXT,                        -- server-resolved, never client-supplied
  product_sku  TEXT,
  product_url  TEXT,
  budget       TEXT,
  dimensions   TEXT,
  image_key    TEXT,                        -- quarantined blob key; admin-only
  source_path  TEXT,
  referrer     TEXT,
  ua_hash      TEXT,
  country      TEXT,
  status       TEXT NOT NULL DEFAULT 'NEW', -- NEW|CONTACTED|FOLLOW_UP|CONVERTED|CLOSED
  note         TEXT,
  spam_score   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS leads_status_created ON leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at DESC);

-- 0003 — analytics, stored as daily aggregates only (no per-visitor rows) -----

CREATE TABLE IF NOT EXISTS event_daily (
  day    TEXT    NOT NULL,               -- 'YYYY-MM-DD', server clock, UTC
  type   TEXT    NOT NULL,
  entity TEXT    NOT NULL DEFAULT '',    -- product slug, category slug, or ''
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, type, entity)
);

CREATE TABLE IF NOT EXISTS search_queries (
  day     TEXT    NOT NULL,
  query   TEXT    NOT NULL,              -- normalised (trimmed, lowercased) query text
  count   INTEGER NOT NULL DEFAULT 0,
  results INTEGER,                       -- most recent result count that day; NULL = unknown
  PRIMARY KEY (day, query)
);

CREATE INDEX IF NOT EXISTS event_daily_day_type ON event_daily (day, type);
CREATE INDEX IF NOT EXISTS search_queries_day ON search_queries (day);
