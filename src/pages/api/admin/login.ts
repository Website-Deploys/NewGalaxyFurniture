/**
 * POST /api/admin/login
 *
 * The one unauthenticated admin endpoint, and therefore the one that has to be
 * careful about what it reveals.
 *
 * **One failure result.** Unknown address, wrong password, and disabled account all
 * return the identical `401 {error:'INVALID_CREDENTIALS'}` body (Requirement 10.5).
 * The handler makes that true along two channels, not just in the body:
 *
 * - *Work performed.* On the unknown-address path it derives a key against
 *   `DUMMY_PASSWORD_HASH`, so the CPU cost of "no such account" equals the cost of
 *   "wrong password" instead of returning in microseconds.
 * - *Elapsed time.* Every response is held until `MIN_RESPONSE_MS` has passed since
 *   the handler started. The floor sits above the real cost of a 600,000-iteration
 *   derivation, so variance in the derivation is absorbed rather than measurable.
 *
 * **The order of the two limits is deliberate.** The per-address window is consumed
 * first and unconditionally, so an attacker cycling addresses cannot avoid it by
 * targeting a locked account. The per-email lock is checked before the credential is
 * examined, so a locked address costs no derivation at all.
 *
 * Design: Admin Authentication → Brute-force and abuse control.
 * Requirements: 10.3, 10.5, 10.9, 10.10, 10.11, 25.8, 25.16, 26.10.
 */

import type { APIContext } from 'astro';
import { z } from 'zod';

import { ERROR_CODES, errorResponse, logServerError, minutesPhrase } from '@/lib/errors';
import { getD1, getKV, getPublicConfig } from '@/lib/env';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/lib/auth/password';
import {
  checkEmailLock,
  clearLoginFailures,
  consumeLoginAttemptForIp,
  hashIdentifier,
  recordLoginFailure,
} from '@/lib/auth/rate-limit';
import { checkOrigin, clientAddress } from '@/lib/auth/guard';
import { createSession, sessionCookieValue } from '@/lib/auth/session';
import {
  findAdminUserWithHash,
  normalizeEmail,
  recordSuccessfulLogin,
  updatePasswordHash,
} from '@/lib/auth/users';

export const prerender = false;

/**
 * The response-time floor. Comfortably above a 600,000-iteration PBKDF2 derivation
 * (~80–300 ms depending on the machine) so the derivation's own variance does not
 * show through.
 */
const MIN_RESPONSE_MS = 700;

const LoginPayload = z.object({
  // No `.email()`: a rejected-because-malformed address and a rejected-because-
  // unknown address must look the same, so shape checking happens after the limits
  // and folds into the same uniform failure.
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(400),
});

async function holdUntilFloor(startedAt: number): Promise<void> {
  const remaining = MIN_RESPONSE_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function uniformFailure(startedAt: number): Promise<Response> {
  await holdUntilFloor(startedAt);
  return errorResponse(ERROR_CODES.INVALID_CREDENTIALS);
}

function rateLimited(minutes: number): Response {
  return errorResponse(ERROR_CODES.RATE_LIMITED, {
    message: `Too many attempts. Try again in ${minutesPhrase(minutes)}.`,
    headers: { 'retry-after': String(Math.max(60, Math.ceil(minutes) * 60)) },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const startedAt = Date.now();
  const { request } = context;

  let db: ReturnType<typeof getD1>;
  let sessions: ReturnType<typeof getKV>;
  let rateLimitKv: ReturnType<typeof getKV>;
  let expectedOrigin: string;
  try {
    db = getD1(context);
    sessions = getKV(context, 'SESSIONS');
    rateLimitKv = getKV(context, 'RATELIMIT');
    expectedOrigin = getPublicConfig(context).siteUrl;
  } catch (error) {
    /*
     * A missing binding or an unset site URL. The response says only that the feature is not
     * configured — an unauthenticated caller learns nothing about which binding — while the log says
     * which one, because otherwise "nobody can sign in" is a 503 with no evidence behind it.
     */
    logServerError('login: a required binding or configuration value is unavailable', error);
    return errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE);
  }

  // Guard step 1 applies to login too: a cross-site POST is refused before any
  // storage access and before the response-time floor is engaged.
  if (!checkOrigin(request, expectedOrigin)) {
    return errorResponse(ERROR_CODES.ORIGIN_MISMATCH);
  }
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return errorResponse(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }

  // Per-address ceiling first, and counted whatever the outcome (Requirement 10.11).
  const ipDecision = await consumeLoginAttemptForIp(rateLimitKv, clientAddress(request));
  if (!ipDecision.allowed) return rateLimited(ipDecision.retryAfterMinutes);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return await uniformFailure(startedAt);
  }
  const parsed = LoginPayload.safeParse(payload);
  if (!parsed.success) return await uniformFailure(startedAt);

  const email = normalizeEmail(parsed.data.email);
  const emailHash = await hashIdentifier(email);

  const lock = await checkEmailLock(db, emailHash);
  if (!lock.allowed) return rateLimited(lock.retryAfterMinutes);

  const found = await findAdminUserWithHash(db, email);
  // Equal work on both branches: the unknown-address path derives against a hash
  // nothing verifies against rather than short-circuiting.
  const storedHash = found?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const verified = await verifyPassword(parsed.data.password, storedHash);

  if (found === null || !verified) {
    const outcome = await recordLoginFailure(db, rateLimitKv, emailHash);
    if (outcome.lockedUntil !== null && outcome.lockMinutes > 0) {
      // The lock message names minutes but still says nothing about whether the
      // address exists — it is reached identically on both branches.
      await holdUntilFloor(startedAt);
      return rateLimited(outcome.lockMinutes);
    }
    return await uniformFailure(startedAt);
  }

  await clearLoginFailures(db, rateLimitKv, emailHash);

  // Transparent cost upgrade, at the only moment the plaintext is in hand and proved.
  if (needsRehash(storedHash)) {
    await updatePasswordHash(db, found.user.id, await hashPassword(parsed.data.password));
  }
  await recordSuccessfulLogin(db, found.user.id);

  const userAgent = request.headers.get('user-agent');
  const session = await createSession(sessions, {
    userId: found.user.id,
    role: found.user.role,
    ip: clientAddress(request),
    ...(userAgent === null ? {} : { userAgent }),
  });

  await holdUntilFloor(startedAt);
  // 204 with no body: the CSRF token is fetched by `GET /api/admin/session`, so it is
  // never delivered on a response that a cross-site attacker could have provoked.
  return new Response(null, {
    status: 204,
    headers: {
      'set-cookie': sessionCookieValue(session),
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
