/**
 * Reads and writes against `admin_users`.
 *
 * Every query is parameterised (Requirement 25.3) — there is no string
 * concatenation anywhere in this file, and the email is lowercased before it
 * reaches a bind parameter so it matches the functional unique index from
 * migration 0001.
 *
 * `password_hash` never leaves this module except to `verifyPassword`. The
 * `AdminUser` type deliberately omits it, so a handler cannot serialize a hash into
 * a response by accident; the one caller that needs it uses
 * `findAdminUserWithHash` and destructures it locally.
 *
 * Design: Admin Authentication → Credential storage.
 * Requirements: 10.4, 10.13, 25.3.
 */

import type { D1Database } from '@cloudflare/workers-types';

import { isRole, type Role } from './permissions';

/** Safe to serialize. Carries no credential material. */
export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  lastLoginAt: string | null;
}

interface AdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

function toAdminUser(row: AdminUserRow): AdminUser | null {
  if (!isRole(row.role)) return null; // a typo'd role grants nothing; fail closed
  if (row.status !== 'ACTIVE' && row.status !== 'DISABLED') return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Look up an active account plus its stored hash, for the login handler only.
 *
 * Returns null for an unknown address *and* for a DISABLED one, so the two are
 * indistinguishable to the caller and therefore to the client.
 */
export async function findAdminUserWithHash(
  db: D1Database,
  email: string,
): Promise<{ user: AdminUser; passwordHash: string } | null> {
  const row = await db
    .prepare(
      'SELECT id, email, password_hash, role, status, created_at, last_login_at ' +
        "FROM admin_users WHERE LOWER(email) = ? AND status = 'ACTIVE'",
    )
    .bind(normalizeEmail(email))
    .first<AdminUserRow>();
  if (row === null) return null;
  const user = toAdminUser(row);
  if (user === null) return null;
  return { user, passwordHash: row.password_hash };
}

/** The account behind a session, for the `Actor:` commit trailer and the session probe. */
export async function findAdminUserById(db: D1Database, id: string): Promise<AdminUser | null> {
  const row = await db
    .prepare(
      'SELECT id, email, password_hash, role, status, created_at, last_login_at ' +
        'FROM admin_users WHERE id = ?',
    )
    .bind(id)
    .first<AdminUserRow>();
  return row === null ? null : toAdminUser(row);
}

export async function recordSuccessfulLogin(
  db: D1Database,
  id: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  await db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').bind(at, id).run();
}

/**
 * Replace a stored hash with one derived under current parameters.
 *
 * Called only on the successful-login path, which is the one moment the plaintext is
 * available and has already been proved correct.
 */
export async function updatePasswordHash(
  db: D1Database,
  id: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?')
    .bind(passwordHash, id)
    .run();
}
