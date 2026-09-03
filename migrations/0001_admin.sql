-- 0001_admin.sql — admin credentials and login abuse state.
--
-- These two tables are the reason D1 exists in this project at all: credentials
-- must never be in version control, so they cannot live in `data/`. Nothing in
-- this file is ever written by the GitHub write pipeline — the path allowlist
-- (src/lib/github/paths.ts) admits only `data/**`, so `migrations/` is
-- structurally unreachable from the admin API.
--
-- Design: Admin Authentication → Credential storage.
-- Requirements: 10.4, 10.13, 10.18.

CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,           -- stored lowercased
  password_hash TEXT NOT NULL,                  -- pbkdf2$sha256$600000$<b64 salt>$<b64 key>
  role          TEXT NOT NULL DEFAULT 'owner',  -- owner | editor | viewer
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DISABLED
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- The UNIQUE constraint on `email` is byte-exact, which is not the same thing as
-- "one account per address": `Owner@example.com` and `owner@example.com` would
-- both be insertable and both would fail to match a lowercased lookup. Every
-- write path lowercases before storing, and this functional index makes that a
-- database guarantee rather than a convention the next caller has to remember.
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_idx
  ON admin_users (LOWER(email));

-- Role and status are checked in the application (src/lib/auth/permissions.ts owns
-- the role vocabulary), but a typo'd role would silently grant nothing and read as
-- a permissions bug, so it is rejected at the boundary instead.
CREATE INDEX IF NOT EXISTS admin_users_status_idx ON admin_users (status);

CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,                -- 'email:<sha256 hex>' or 'ip:<sha256 hex>'
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- `key` holds a hash, never a raw email or IP: the lockout table is queried on
-- every login attempt including failed ones, so an attacker who obtained a dump
-- of it must not learn which addresses exist. src/lib/auth/rate-limit.ts owns the
-- hashing and the 1/5/15/60-minute escalation ladder.
