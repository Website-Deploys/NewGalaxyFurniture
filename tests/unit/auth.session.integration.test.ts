import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import {
  checkEmailLock,
  clearLoginFailures,
  consumeLoginAttemptForIp,
  hashIdentifier,
  LOCK_LADDER_MINUTES,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_IP_LIMIT,
  LOGIN_IP_WINDOW_MS,
  recordLoginFailure,
} from '@/lib/auth/rate-limit';
import {
  ABSOLUTE_TTL_MS,
  IDLE_TTL_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  clearedSessionCookieValue,
  createSession,
  destroySession,
  readSession,
  readSessionCookie,
  sessionCookieValue,
  touchSession,
} from '@/lib/auth/session';

/**
 * Session and lockout lifecycle, against **real local bindings**.
 *
 * `getPlatformProxy` starts the same workerd-backed KV and D1 the Worker gets in
 * production, driven by the project's own `wrangler.toml`. That matters more than it
 * might look: an in-memory fake would let this suite pass while `expirationTtl`
 * validation, D1's `ON CONFLICT` upsert, or the `LOWER(email)` functional index were
 * all quietly wrong. The `admin_users` / `login_attempts` schema comes from
 * `migrations/0001_admin.sql` itself, so a syntax error in the migration fails here
 * rather than at deploy time.
 *
 * Time is injected rather than waited on. Every function under test takes a `now`, so
 * the 2-hour idle boundary and the 12-hour absolute cap are exercised exactly at their
 * edges instead of approximately, and the suite still runs in seconds.
 *
 * Requirements: 10.3, 10.6, 10.7, 10.10, 10.11, 25.11.
 */

const MINUTE = 60_000;
const MIGRATION_PATH = fileURLToPath(new URL('../../migrations/0001_admin.sql', import.meta.url));

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let sessions: KVNamespace;
let rateLimitKv: KVNamespace;
let db: D1Database;

/** Split the real migration into statements and run each. */
async function applyMigration(database: D1Database): Promise<void> {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
    .replace(/^\s*--.*$/gm, '') // line comments would confuse the split
    .trim();
  for (const statement of sql.split(';')) {
    const trimmed = statement.trim();
    if (trimmed === '') continue;
    await database.prepare(trimmed).run();
  }
}

beforeAll(async () => {
  proxy = await getPlatformProxy({ configPath: './wrangler.toml', persist: false });
  // `getPlatformProxy` types `env` loosely (it cannot know this project's bindings), so
  // the three this suite drives are named here.
  const env = proxy.env as {
    SESSIONS: KVNamespace;
    RATELIMIT: KVNamespace;
    DB: D1Database;
  };
  sessions = env.SESSIONS;
  rateLimitKv = env.RATELIMIT;
  db = env.DB;
  await applyMigration(db);
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
}, 60_000);

/** Each test starts from a clean lockout table; sessions are keyed by random id. */
beforeEach(async () => {
  await db.prepare('DELETE FROM login_attempts').run();
});

describe('the migration produces the schema the auth layer queries', () => {
  it('creates admin_users with a case-insensitive unique email', async () => {
    await db
      .prepare(
        'INSERT INTO admin_users (id, email, password_hash, role, status, created_at) ' +
          "VALUES ('usr_a', 'owner@example.test', 'pbkdf2$sha256$1$AA$AA', 'owner', 'ACTIVE', '2026-01-01T00:00:00.000Z')",
      )
      .run();

    // The functional index is the point: a differently-cased duplicate must be
    // rejected, not silently accepted and then never matched by a lowercased lookup.
    await expect(
      db
        .prepare(
          'INSERT INTO admin_users (id, email, password_hash, role, status, created_at) ' +
            "VALUES ('usr_b', 'Owner@Example.TEST', 'pbkdf2$sha256$1$AA$AA', 'owner', 'ACTIVE', '2026-01-01T00:00:00.000Z')",
        )
        .run(),
    ).rejects.toThrow();

    await db.prepare('DELETE FROM admin_users').run();
  });
});

describe('session issue and read', () => {
  it('issues an opaque session with independent id and CSRF token', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const session = await createSession(
      sessions,
      { userId: 'usr_1', role: 'owner', ip: '203.0.113.7', userAgent: 'Test/1.0' },
      now,
    );

    expect(session.id).not.toBe(session.csrfToken);
    // 32 bytes, base64url, unpadded.
    expect(session.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toBe(now + ABSOLUTE_TTL_MS);
    expect(session.lastSeenAt).toBe(now);
    // The UA is stored as a digest, never verbatim.
    expect(session.uaHash).toBeDefined();
    expect(session.uaHash).not.toContain('Test');

    const read = await readSession(sessions, session.id, now + MINUTE);
    expect(read).toEqual(session);
  });

  it('sets the cookie with every required attribute', async () => {
    const session = await createSession(sessions, { userId: 'usr_1', role: 'owner' });
    const cookie = sessionCookieValue(session);

    expect(cookie).toContain(`${SESSION_COOKIE}=${session.id}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(43_200);

    // Round-trips through a realistic Cookie header alongside other cookies.
    const header = `theme=dark; ${SESSION_COOKIE}=${session.id}; other=1`;
    expect(readSessionCookie(header)).toBe(session.id);
    expect(readSessionCookie(null)).toBe('');
    expect(readSessionCookie('unrelated=1')).toBe('');
    expect(clearedSessionCookieValue()).toContain('Max-Age=0');
  });

  it('returns null for an id that was never issued', async () => {
    expect(await readSession(sessions, 'not-a-real-session-id')).toBeNull();
    expect(await readSession(sessions, '')).toBeNull();
  });
});

describe('idle renewal', () => {
  it('does not write before the 5-minute interval, and does after', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const session = await createSession(sessions, { userId: 'usr_1', role: 'editor' }, now);

    // Inside the interval: same object back, and — the part that matters — the stored
    // record is untouched, so this costs no KV write.
    const early = now + LAST_SEEN_WRITE_INTERVAL_MS - 1;
    const untouched = await touchSession(sessions, session, early);
    expect(untouched.lastSeenAt).toBe(now);
    expect((await readSession(sessions, session.id, early))?.lastSeenAt).toBe(now);

    // At the interval: persisted.
    const later = now + LAST_SEEN_WRITE_INTERVAL_MS;
    const touched = await touchSession(sessions, session, later);
    expect(touched.lastSeenAt).toBe(later);
    expect((await readSession(sessions, session.id, later))?.lastSeenAt).toBe(later);
  });

  it('keeps a continuously active session alive across the idle window', async () => {
    let now = Date.UTC(2026, 0, 15, 9, 0, 0);
    let session = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);

    // Activity every 30 minutes for 5 hours: past the 2-hour idle window several
    // times over, but never idle for 2 hours, so the session must survive.
    for (let step = 0; step < 10; step += 1) {
      now += 30 * MINUTE;
      const read = await readSession(sessions, session.id, now);
      expect(read).not.toBeNull();
      session = await touchSession(sessions, read!, now);
    }
    expect(await readSession(sessions, session.id, now)).not.toBeNull();
  });
});

describe('idle expiry at 2 hours', () => {
  it('accepts at one millisecond before the boundary and refuses at it', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const a = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);
    expect(await readSession(sessions, a.id, now + IDLE_TTL_MS - 1)).not.toBeNull();

    const b = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);
    expect(await readSession(sessions, b.id, now + IDLE_TTL_MS)).toBeNull();
  });

  it('deletes the record on idle expiry so the cookie cannot be replayed', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const session = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);

    expect(await readSession(sessions, session.id, now + IDLE_TTL_MS)).toBeNull();
    // Reading again at a *valid* time must still fail: the record is gone, not merely
    // filtered out by the clock. Without the delete, a clock skew or a replay at an
    // earlier timestamp would resurrect the session.
    expect(await readSession(sessions, session.id, now + MINUTE)).toBeNull();
    expect(await sessions.get(`session:${session.id}`)).toBeNull();
  });
});

describe('absolute expiry at 12 hours', () => {
  it('refuses at the cap even when the session was active throughout', async () => {
    let now = Date.UTC(2026, 0, 15, 0, 0, 0);
    const created = now;
    let session = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);

    // Touched every 30 minutes for the full 12 hours: never idle, so only the
    // absolute cap can end it.
    while (now < created + ABSOLUTE_TTL_MS - 30 * MINUTE) {
      now += 30 * MINUTE;
      const read = await readSession(sessions, session.id, now);
      expect(read).not.toBeNull();
      session = await touchSession(sessions, read!, now);
    }

    expect(await readSession(sessions, session.id, created + ABSOLUTE_TTL_MS - 1)).not.toBeNull();
    expect(await readSession(sessions, session.id, created + ABSOLUTE_TTL_MS)).toBeNull();
    expect(await sessions.get(`session:${session.id}`)).toBeNull();
  });

  it('never extends expiresAt through renewal', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const session = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);
    const touched = await touchSession(sessions, session, now + 6 * 60 * MINUTE);
    // The whole point of an absolute cap: activity must not push it out.
    expect(touched.expiresAt).toBe(session.expiresAt);
  });
});

describe('logout revocation', () => {
  it('makes the previously issued cookie value unusable', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const session = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);
    const capturedCookie = sessionCookieValue(session);
    expect(await readSession(sessions, session.id, now)).not.toBeNull();

    await destroySession(sessions, session.id);

    // The captured cookie still parses — cookies are not revocable — but the id it
    // carries resolves to nothing, which is where the revocation actually lives.
    const replayedId = readSessionCookie(capturedCookie.split(';')[0] ?? '');
    expect(replayedId).toBe(session.id);
    expect(await readSession(sessions, replayedId, now)).toBeNull();
    expect(await sessions.get(`session:${session.id}`)).toBeNull();
  });

  it('does not affect other sessions for the same user', async () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    const a = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);
    const b = await createSession(sessions, { userId: 'usr_1', role: 'owner' }, now);

    await destroySession(sessions, a.id);

    expect(await readSession(sessions, a.id, now)).toBeNull();
    expect(await readSession(sessions, b.id, now)).not.toBeNull();
  });
});

describe('per-email lockout escalation', () => {
  it('escalates through 1, 5, 15 and 60 minutes and then holds at 60', async () => {
    const emailHash = await hashIdentifier('owner@example.test');
    let now = Date.UTC(2026, 0, 15, 9, 0, 0);

    const observed: number[] = [];
    // Five ladder rungs: the fourth and fifth must both be 60, which is what
    // "progressively longer periods of 1, 5, 15, and 60" means for a persistent
    // attacker — the ladder saturates rather than wrapping back to 1.
    for (let rung = 0; rung < 5; rung += 1) {
      let applied = 0;
      for (let attempt = 0; attempt < LOGIN_FAILURE_THRESHOLD; attempt += 1) {
        const outcome = await recordLoginFailure(db, rateLimitKv, emailHash, now);
        if (outcome.lockMinutes > 0) applied = outcome.lockMinutes;
        now += 30_000; // half a minute apart: all five inside the 15-minute window
      }
      observed.push(applied);

      // The lock is in force, reported in whole minutes, and lifts on schedule.
      const during = await checkEmailLock(db, emailHash, now);
      expect(during.allowed).toBe(false);
      expect(during.retryAfterMinutes).toBeGreaterThan(0);
      expect(Number.isInteger(during.retryAfterMinutes)).toBe(true);

      now += applied * MINUTE + MINUTE;
      expect((await checkEmailLock(db, emailHash, now)).allowed).toBe(true);
    }

    expect(observed).toEqual([...LOCK_LADDER_MINUTES, 60]);
  });

  it('does not lock before the threshold is reached', async () => {
    const emailHash = await hashIdentifier('editor@example.test');
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);

    for (let attempt = 0; attempt < LOGIN_FAILURE_THRESHOLD - 1; attempt += 1) {
      const outcome = await recordLoginFailure(db, rateLimitKv, emailHash, now + attempt * 1000);
      expect(outcome.lockMinutes).toBe(0);
      expect(outcome.lockedUntil).toBeNull();
    }
    expect((await checkEmailLock(db, emailHash, now)).allowed).toBe(true);
  });

  it('does not lock when failures are spread beyond the window', async () => {
    const emailHash = await hashIdentifier('slow@example.test');
    let now = Date.UTC(2026, 0, 15, 9, 0, 0);

    // Ten failures, each 20 minutes apart. The running total passes the threshold
    // twice over, but no *window* ever holds five, so nothing locks. This is the
    // "within 15 minutes" clause of Requirement 10.10.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const outcome = await recordLoginFailure(db, rateLimitKv, emailHash, now);
      expect(outcome.lockMinutes).toBe(0);
      now += 20 * MINUTE;
    }
    expect((await checkEmailLock(db, emailHash, now)).allowed).toBe(true);
  });

  it('clears both the running total and the window on a successful login', async () => {
    const emailHash = await hashIdentifier('reset@example.test');
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);

    for (let attempt = 0; attempt < LOGIN_FAILURE_THRESHOLD - 1; attempt += 1) {
      await recordLoginFailure(db, rateLimitKv, emailHash, now + attempt * 1000);
    }
    await clearLoginFailures(db, rateLimitKv, emailHash);

    // If the window survived a success, four stale failures plus one new one would
    // lock a legitimate operator out immediately after signing in.
    const afterReset = await recordLoginFailure(db, rateLimitKv, emailHash, now + 10_000);
    expect(afterReset.fails).toBe(1);
    expect(afterReset.lockMinutes).toBe(0);
    expect((await checkEmailLock(db, emailHash, now + 10_000)).allowed).toBe(true);
  });

  it('keeps one address’s lock away from another', async () => {
    const locked = await hashIdentifier('locked@example.test');
    const other = await hashIdentifier('other@example.test');
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);

    for (let attempt = 0; attempt < LOGIN_FAILURE_THRESHOLD; attempt += 1) {
      await recordLoginFailure(db, rateLimitKv, locked, now + attempt * 1000);
    }
    expect((await checkEmailLock(db, locked, now)).allowed).toBe(false);
    expect((await checkEmailLock(db, other, now)).allowed).toBe(true);
  });

  it('stores a hash rather than the address', async () => {
    const email = 'secret-address@example.test';
    const emailHash = await hashIdentifier(email);
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);
    await recordLoginFailure(db, rateLimitKv, emailHash, now);

    const rows = await db.prepare('SELECT key FROM login_attempts').all<{ key: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      expect(row.key).not.toContain(email);
      expect(row.key).toMatch(/^email:[0-9a-f]{64}$/);
    }
  });
});

describe('per-address login cap', () => {
  it('allows 20 attempts per 15 minutes and refuses the 21st', async () => {
    const ip = '198.51.100.42';
    const now = Date.UTC(2026, 0, 15, 9, 0, 0);

    for (let attempt = 0; attempt < LOGIN_IP_LIMIT; attempt += 1) {
      const decision = await consumeLoginAttemptForIp(rateLimitKv, ip, now + attempt * 1000);
      expect(decision.allowed).toBe(true);
    }

    const refused = await consumeLoginAttemptForIp(rateLimitKv, ip, now + 21_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMinutes).toBeGreaterThan(0);
    expect(refused.retryAfterMinutes).toBeLessThanOrEqual(15);

    // A different address is unaffected, so one noisy client cannot lock out the site.
    expect((await consumeLoginAttemptForIp(rateLimitKv, '198.51.100.43', now)).allowed).toBe(true);

    // And the window really is a window.
    const afterWindow = await consumeLoginAttemptForIp(
      rateLimitKv,
      ip,
      now + LOGIN_IP_WINDOW_MS + MINUTE,
    );
    expect(afterWindow.allowed).toBe(true);
  }, 60_000);
});
