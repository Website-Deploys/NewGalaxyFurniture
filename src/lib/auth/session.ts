/**
 * Opaque server-side sessions in KV.
 *
 * No JWT. The cookie holds 32 random bytes and nothing else — no claims, no role,
 * no expiry the client could edit, and no signature to attack. Authority is looked
 * up server-side on every request, which makes revocation immediate: deleting the
 * KV record ends the session everywhere, instantly, with no denylist to maintain.
 *
 * Two expiries, both enforced on read rather than trusted from storage:
 *
 * - **Absolute**, 12 h from creation. Matches the KV TTL, so an abandoned record
 *   also disappears on its own.
 * - **Idle**, 2 h since `lastSeenAt`. `touchSession` refreshes it, but writes at
 *   most once every 5 minutes — a KV write per request would cost a round trip on
 *   every admin interaction to record information that changes nothing.
 *
 * Every function takes the `KVNamespace` explicitly instead of reaching for a
 * request context. That is what lets `tests/unit/auth.session.integration.test.ts`
 * drive the real lifecycle against a real local KV namespace, and it keeps this
 * module free of Astro.
 *
 * Design: Admin Authentication → Sessions.
 * Requirements: 10.3, 10.6, 10.7, 25.11.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { Role } from './permissions';

export interface Session {
  /** 32 random bytes, base64url — the cookie value. */
  id: string;
  userId: string;
  role: Role;
  /** 32 random bytes, base64url. Lives here, never in a readable cookie. */
  csrfToken: string;
  createdAt: number;
  /** Absolute cap: `createdAt + ABSOLUTE_TTL_MS`. */
  expiresAt: number;
  /** Idle clock. Compared against `IDLE_TTL_MS` on every read. */
  lastSeenAt: number;
  ip?: string;
  uaHash?: string;
}

export const SESSION_COOKIE = 'ngf_session';
export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** `lastSeenAt` is persisted at most this often. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
/** `Max-Age` in seconds — 43200, the absolute cap. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = ABSOLUTE_TTL_MS / 1000;
const TOKEN_BYTES = 32;
/** Cloudflare KV rejects `expirationTtl` below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

function kvKey(id: string): string {
  return `session:${id}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 cryptographically random bytes, base64url. Used for both ids and CSRF tokens. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * A truncated SHA-256 of the user agent.
 *
 * Stored to make "this session moved to a different browser" observable in logs
 * without retaining the UA string itself, which is a fingerprinting surface with no
 * operational value here.
 */
export async function hashUserAgent(userAgent: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userAgent));
  return base64url(new Uint8Array(digest)).slice(0, 22);
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.userId === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.csrfToken === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.expiresAt === 'number' &&
    typeof candidate.lastSeenAt === 'number'
  );
}

/** Seconds of KV TTL left for a session, floored at the platform minimum. */
function ttlSeconds(session: Session, now: number): number {
  return Math.max(KV_MIN_TTL_SECONDS, Math.ceil((session.expiresAt - now) / 1000));
}

async function persist(kv: KVNamespace, session: Session, now: number): Promise<void> {
  await kv.put(kvKey(session.id), JSON.stringify(session), {
    expirationTtl: ttlSeconds(session, now),
  });
}

export interface CreateSessionInput {
  userId: string;
  role: Role;
  ip?: string;
  userAgent?: string;
}

/**
 * Issue a session and store it.
 *
 * `now` is injectable so the lifecycle test can advance a virtual clock across 12
 * hours without waiting, and so every timestamp in one request agrees.
 */
export async function createSession(
  kv: KVNamespace,
  input: CreateSessionInput,
  now: number = Date.now(),
): Promise<Session> {
  const session: Session = {
    id: randomToken(),
    userId: input.userId,
    role: input.role,
    csrfToken: randomToken(),
    createdAt: now,
    expiresAt: now + ABSOLUTE_TTL_MS,
    lastSeenAt: now,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(input.userAgent === undefined ? {} : { uaHash: await hashUserAgent(input.userAgent) }),
  };
  await persist(kv, session, now);
  return session;
}

/**
 * Read a session, enforcing both expiries.
 *
 * An expired record is deleted before returning null, so an expired cookie cannot
 * be replayed against a record KV is still holding for its minimum TTL. A record
 * that does not deserialize into a `Session` is treated the same way: fail closed
 * and remove it.
 */
export async function readSession(
  kv: KVNamespace,
  id: string,
  now: number = Date.now(),
): Promise<Session | null> {
  if (id === '') return null;
  const raw = await kv.get(kvKey(id), 'text');
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await kv.delete(kvKey(id));
    return null;
  }
  if (!isSession(parsed)) {
    await kv.delete(kvKey(id));
    return null;
  }
  // The id is authoritative from the cookie, not from the stored body.
  if (parsed.id !== id) {
    await kv.delete(kvKey(id));
    return null;
  }
  if (now >= parsed.expiresAt || now - parsed.lastSeenAt >= IDLE_TTL_MS) {
    await kv.delete(kvKey(id));
    return null;
  }
  return parsed;
}

/**
 * Refresh the idle clock.
 *
 * Returns the session either way, so callers can use the result unconditionally.
 * The write is skipped when the recorded `lastSeenAt` is younger than
 * `LAST_SEEN_WRITE_INTERVAL_MS`: the idle window is two hours, so five minutes of
 * imprecision is invisible, and the saved write is on every single admin request.
 */
export async function touchSession(
  kv: KVNamespace,
  session: Session,
  now: number = Date.now(),
): Promise<Session> {
  if (now - session.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS) return session;
  const refreshed: Session = { ...session, lastSeenAt: now };
  await persist(kv, refreshed, now);
  return refreshed;
}

/**
 * End a session.
 *
 * Deleting the KV record is what makes the previously issued cookie useless: there
 * is nothing left to look it up against. Clearing the cookie is a courtesy to the
 * browser, not the security boundary.
 */
export async function destroySession(kv: KVNamespace, id: string): Promise<void> {
  if (id === '') return;
  await kv.delete(kvKey(id));
}

/* -------------------------------------------------------------------------- */
/* Cookie plumbing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `SameSite=Lax`, not `Strict`: `Strict` drops the cookie when an operator follows
 * an external link back into `/admin`, which reads as a random logout. CSRF is
 * handled by the token and the origin check, not by the cookie attribute.
 */
export function sessionCookieValue(session: Session): string {
  return [
    `${SESSION_COOKIE}=${session.id}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ');
}

/** The `Set-Cookie` value that removes the cookie. */
export function clearedSessionCookieValue(): string {
  return [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=0'].join(
    '; ',
  );
}

/** Read the session id out of a `Cookie` header. Returns '' when absent. */
export function readSessionCookie(cookieHeader: string | null): string {
  if (cookieHeader === null) return '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

/** Convenience: cookie header → validated session, or null. */
export async function readSessionFromRequest(
  kv: KVNamespace,
  request: Request,
  now: number = Date.now(),
): Promise<Session | null> {
  return await readSession(kv, readSessionCookie(request.headers.get('cookie')), now);
}
