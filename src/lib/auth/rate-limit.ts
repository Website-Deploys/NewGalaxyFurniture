/**
 * Rate limits, login lockout, and the abuse-control table.
 *
 * Every row of the design's abuse-control table is implemented here, and the split
 * between mechanisms is forced by the platform rather than chosen:
 *
 * - **The Rate Limiting binding** supports 10 s and 60 s periods only. It therefore
 *   covers the per-minute rows (admin API, events) and nothing else.
 * - **KV counters** cover every window longer than a minute: the 15-minute login
 *   windows, the 10-minute upload cap, and the hourly AI and lead caps.
 * - **D1 `login_attempts`** holds the escalating per-email lock, because a lockout
 *   must survive a KV eviction and must be inspectable by an operator.
 *
 * How the 1/5/15/60 ladder is derived from the design's two-column table. The
 * schema is fixed by the design (`fails`, `locked_until`) and has nowhere to record
 * a "last failure" timestamp, so decay cannot be computed from D1 alone. The two
 * mechanisms divide the problem the way the design's table implies:
 *
 * - The **15-minute window** is a KV counter. Five failures inside one window is
 *   the trigger; the counter is reset when it fires so the next window starts clean.
 * - The **escalation level** is `floor(fails / 5)` over the D1 running total, which
 *   only ever resets on a successful login. First trigger → 1 min, second → 5 min,
 *   third → 15 min, fourth and later → 60 min.
 *
 * Every key is a SHA-256 hash. `login_attempts` is read on every attempt including
 * failures, so a dump of it must not reveal which addresses exist.
 *
 * Design: Admin Authentication → Brute-force and abuse control.
 * Requirements: 10.10, 10.11, 10.12, 25.8, 26.10.
 */

import type { D1Database, KVNamespace, RateLimit } from '@cloudflare/workers-types';

const MINUTE_MS = 60_000;

/** Failures inside one window before the lock escalates. */
export const LOGIN_FAILURE_THRESHOLD = 5;
/** The window failures are counted in. */
export const LOGIN_FAILURE_WINDOW_MS = 15 * MINUTE_MS;
/** The escalation ladder, in minutes. The last entry repeats for every further lock. */
export const LOCK_LADDER_MINUTES: readonly number[] = [1, 5, 15, 60];
/** Login attempts — successful or not — allowed per client address per window. */
export const LOGIN_IP_LIMIT = 20;
export const LOGIN_IP_WINDOW_MS = 15 * MINUTE_MS;

/**
 * The rest of the abuse-control table, as data so the endpoints cannot drift from
 * it. `scope` names what the counter is keyed by.
 */
export const KV_RATE_LIMITS = {
  /** 30 uploads / 10 min per session. */
  imageUpload: { limit: 30, windowMs: 10 * MINUTE_MS, scope: 'session' },
  /** 20 generations / hour per session — cost containment, not abuse prevention. */
  aiGenerate: { limit: 20, windowMs: 60 * MINUTE_MS, scope: 'session' },
  /** 5 leads / hour per IP, on top of the honeypot and the minimum time-on-form. */
  leadSubmit: { limit: 5, windowMs: 60 * MINUTE_MS, scope: 'ip' },
} as const satisfies Record<string, { limit: number; windowMs: number; scope: 'session' | 'ip' }>;

export type KvRateLimitName = keyof typeof KV_RATE_LIMITS;

/** 120 admin API requests per minute per session — the RL_ADMIN_API binding's row. */
export const ADMIN_API_LIMIT_PER_MINUTE = 120;
/** 200 events per minute per IP — the RL_EVENTS binding's row. */
export const EVENTS_LIMIT_PER_MINUTE = 200;

export interface RateLimitDecision {
  allowed: boolean;
  /**
   * Whole minutes the caller must wait. Zero when allowed. Requirement 26.10 wants
   * "try again in N minutes", so a 90-second wait rounds up to 2 rather than
   * reporting 1.5 or a bare 90.
   */
  retryAfterMinutes: number;
}

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterMinutes: 0 };

function denyUntil(until: number, now: number): RateLimitDecision {
  return {
    allowed: false,
    retryAfterMinutes: Math.max(1, Math.ceil((until - now) / MINUTE_MS)),
  };
}

/** SHA-256 hex. Used for every identifier that becomes part of a storage key. */
export async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* -------------------------------------------------------------------------- */
/* KV fixed-window counters                                                   */
/* -------------------------------------------------------------------------- */

interface WindowRecord {
  count: number;
  /** Wall-clock end of the window. The record is also given a matching KV TTL. */
  resetAt: number;
}

function isWindowRecord(value: unknown): value is WindowRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.count === 'number' && typeof candidate.resetAt === 'number';
}

async function readWindow(
  kv: KVNamespace,
  key: string,
  windowMs: number,
  now: number,
): Promise<WindowRecord> {
  const raw = await kv.get(key, 'text');
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isWindowRecord(parsed) && parsed.resetAt > now) return parsed;
    } catch {
      // A corrupt counter fails open into a fresh window rather than locking the
      // operator out permanently; the D1 lock is the durable half of the defence.
    }
  }
  return { count: 0, resetAt: now + windowMs };
}

async function writeWindow(kv: KVNamespace, key: string, record: WindowRecord): Promise<void> {
  // KV's minimum expirationTtl is 60 s; every window here is at least 10 min.
  await kv.put(key, JSON.stringify(record), {
    expirationTtl: Math.max(60, Math.ceil((record.resetAt - Date.now()) / 1000)),
  });
}

/**
 * Count one event against a fixed window and decide.
 *
 * Read-modify-write on KV is not atomic, so two simultaneous requests can both see
 * the same count. That is accepted deliberately: these are abuse ceilings measured
 * in tens per window, and an occasional off-by-one under a race is immaterial. The
 * limits that must be exact — the login lock — are in D1.
 */
export async function consumeWindow(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const record = await readWindow(kv, key, windowMs, now);
  if (record.count >= limit) return denyUntil(record.resetAt, now);
  await writeWindow(kv, key, { count: record.count + 1, resetAt: record.resetAt });
  return ALLOWED;
}

/** Inspect a window without consuming from it. */
export async function peekWindow(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const record = await readWindow(kv, key, windowMs, now);
  return record.count >= limit ? denyUntil(record.resetAt, now) : ALLOWED;
}

/** Apply one of the named `KV_RATE_LIMITS` rows to a session id or client address. */
export async function consumeNamedLimit(
  kv: KVNamespace,
  name: KvRateLimitName,
  subject: string,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const row = KV_RATE_LIMITS[name];
  const key = `rl:${name}:${row.scope}:${await hashIdentifier(subject)}`;
  return await consumeWindow(kv, key, row.limit, row.windowMs, now);
}

/**
 * The Rate Limiting binding rows (admin API, events).
 *
 * Fails **open** when the binding is absent, and that is the right default: the
 * binding is a smoothing device on top of authentication, and losing it in a
 * misconfigured preview environment should not make the admin API unusable. The
 * limits that protect a secret — login — never take this path.
 */
export async function consumeBindingLimit(
  limiter: RateLimit | undefined,
  key: string,
): Promise<RateLimitDecision> {
  if (limiter === undefined) return ALLOWED;
  const outcome = await limiter.limit({ key });
  return outcome.success ? ALLOWED : { allowed: false, retryAfterMinutes: 1 };
}

/* -------------------------------------------------------------------------- */
/* Login: per-IP window                                                       */
/* -------------------------------------------------------------------------- */

function loginIpKey(ipHash: string): string {
  return `rl:login:ip:${ipHash}`;
}

function loginEmailWindowKey(emailHash: string): string {
  return `rl:login:email:${emailHash}`;
}

/** Count one login attempt from a client address (Requirement 10.11). */
export async function consumeLoginAttemptForIp(
  kv: KVNamespace,
  ip: string,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const key = loginIpKey(await hashIdentifier(ip));
  return await consumeWindow(kv, key, LOGIN_IP_LIMIT, LOGIN_IP_WINDOW_MS, now);
}

/* -------------------------------------------------------------------------- */
/* Login: per-email escalating lock                                           */
/* -------------------------------------------------------------------------- */

/** The lock length for the nth escalation, 1-based; saturates at the last rung. */
export function lockMinutesForEscalation(escalation: number): number {
  if (escalation < 1) return 0;
  const index = Math.min(escalation, LOCK_LADDER_MINUTES.length) - 1;
  return LOCK_LADDER_MINUTES[index] ?? 60;
}

export function loginAttemptKey(emailHash: string): string {
  return `email:${emailHash}`;
}

interface AttemptRow {
  fails: number;
  lockedUntil: number | null;
}

async function readAttemptRow(db: D1Database, key: string): Promise<AttemptRow> {
  const row = await db
    .prepare('SELECT fails, locked_until FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ fails: number; locked_until: string | null }>();
  if (row === null) return { fails: 0, lockedUntil: null };
  const lockedUntil =
    row.locked_until === null || row.locked_until === '' ? null : Date.parse(row.locked_until);
  return {
    fails: row.fails,
    lockedUntil: lockedUntil !== null && Number.isFinite(lockedUntil) ? lockedUntil : null,
  };
}

/**
 * Is this address currently locked out?
 *
 * Called before the credential is examined, so a locked address costs no key
 * derivation at all.
 */
export async function checkEmailLock(
  db: D1Database,
  emailHash: string,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const row = await readAttemptRow(db, loginAttemptKey(emailHash));
  if (row.lockedUntil !== null && row.lockedUntil > now) return denyUntil(row.lockedUntil, now);
  return ALLOWED;
}

export interface LoginFailureOutcome {
  /** Consecutive failures recorded for this address since the last success. */
  fails: number;
  /** Epoch ms the lock lifts, or null when the threshold was not reached. */
  lockedUntil: number | null;
  /** Whole minutes of lock just applied; 0 when no lock was applied. */
  lockMinutes: number;
}

/**
 * Record one failed attempt and escalate the lock when the window threshold is met.
 *
 * `db` and `kv` are both required because the two halves of the decision live in
 * different stores by design: the durable running total in D1, the 15-minute decay
 * in KV.
 */
export async function recordLoginFailure(
  db: D1Database,
  kv: KVNamespace,
  emailHash: string,
  now: number = Date.now(),
): Promise<LoginFailureOutcome> {
  const key = loginAttemptKey(emailHash);
  const previous = await readAttemptRow(db, key);
  const fails = previous.fails + 1;

  const windowKey = loginEmailWindowKey(emailHash);
  const window = await readWindow(kv, windowKey, LOGIN_FAILURE_WINDOW_MS, now);
  const windowCount = window.count + 1;

  let lockedUntil =
    previous.lockedUntil !== null && previous.lockedUntil > now ? previous.lockedUntil : null;
  let lockMinutes = 0;

  if (windowCount >= LOGIN_FAILURE_THRESHOLD) {
    const escalation = Math.max(1, Math.floor(fails / LOGIN_FAILURE_THRESHOLD));
    lockMinutes = lockMinutesForEscalation(escalation);
    lockedUntil = now + lockMinutes * MINUTE_MS;
    // The window resets when it fires, so the next rung needs another five
    // failures rather than escalating on every attempt after the fifth.
    await writeWindow(kv, windowKey, { count: 0, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
  } else {
    await writeWindow(kv, windowKey, { count: windowCount, resetAt: window.resetAt });
  }

  await db
    .prepare(
      'INSERT INTO login_attempts (key, fails, locked_until) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until',
    )
    .bind(key, fails, lockedUntil === null ? null : new Date(lockedUntil).toISOString())
    .run();

  return { fails, lockedUntil, lockMinutes };
}

/**
 * Clear the failure state for an address after a successful login.
 *
 * Both stores are cleared: leaving the KV window populated would let four stale
 * failures plus one new one trip a lock immediately after a legitimate login.
 */
export async function clearLoginFailures(
  db: D1Database,
  kv: KVNamespace,
  emailHash: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM login_attempts WHERE key = ?')
    .bind(loginAttemptKey(emailHash))
    .run();
  await kv.delete(loginEmailWindowKey(emailHash));
}
