/**
 * The admin request guard.
 *
 * One function decides whether an `/api/admin/**` request proceeds, and it runs the
 * checks in exactly the design's order:
 *
 *   origin/referer → session → CSRF → permission → payload
 *
 * The order matters and is not arbitrary. Origin is first because a cross-site
 * request must be refused before it can cost a KV read or reveal, by timing, that a
 * session exists. Permission is checked before the payload is parsed so an
 * unauthorized caller learns nothing about the schema. And every failure returns
 * before any handler runs, so a refused request provably performs no data change
 * (Requirement 10.1) — that is a property of the control flow, not of handler
 * discipline.
 *
 * The evaluation is split in two:
 *
 * - `evaluateGuard` is pure with respect to Astro: it takes a request, a KV
 *   namespace, and the expected origin. That is what makes it directly testable and
 *   what keeps the security decision out of the framework layer.
 * - `requireAdmin` is the thin Astro-facing wrapper that reads bindings.
 *
 * Design: Admin Authentication → CSRF; Endpoint contracts (error envelope).
 * Requirements: 10.1, 10.8, 10.9, 11.5, 12.10, 25.4.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { z } from 'zod';

import { ERROR_CODES, errorResponse } from '../errors';
import { getKV, getPublicConfig } from '../env';
import { can, type Permission } from './permissions';
import {
  clearedSessionCookieValue,
  readSessionCookie,
  readSession,
  touchSession,
  type Session,
} from './session';
import { findAdminRoute, type AdminRoute } from './routes';

/** Methods that cannot change state and therefore skip the origin and CSRF checks. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_HEADER = 'X-CSRF-Token';

export type GuardOutcome =
  { ok: true; session: Session; route: AdminRoute } | { ok: false; response: Response };

export interface GuardInput {
  request: Request;
  /** KV `SESSIONS`. */
  sessions: KVNamespace;
  /** The deployment origin — the scheme and host of `PUBLIC_SITE_URL`, nothing hard-coded. */
  expectedOrigin: string;
  now?: number;
}

function originOf(value: string | null): string | null {
  if (value === null || value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Step 1 — the request must come from this deployment.
 *
 * `Origin` is preferred; `Referer` is the documented fallback for the browsers and
 * proxies that omit `Origin` on same-origin requests. When neither header is
 * present on an unsafe method the request is refused: a missing `Origin` on a POST
 * is the signature of a hand-rolled cross-site form, and there is no legitimate
 * admin client that omits both.
 */
export function checkOrigin(request: Request, expectedOrigin: string): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const expected = originOf(expectedOrigin);
  if (expected === null) return false;
  const origin = originOf(request.headers.get('origin'));
  if (origin !== null) return origin === expected;
  const referer = originOf(request.headers.get('referer'));
  if (referer !== null) return referer === expected;
  return false;
}

/** Constant-time string comparison for the CSRF token. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Step 4b — content type.
 *
 * Enforced on unsafe methods only, and the multipart upload route is exempted by
 * its own table entry rather than by a path comparison here. A `simple request`
 * content type (`text/plain`, `application/x-www-form-urlencoded`, `multipart/…`)
 * is what lets a cross-site form post without a preflight, so requiring JSON is a
 * CSRF control in its own right — which is why the upload route, which cannot use
 * JSON, still requires the CSRF header.
 */
function checkContentType(request: Request, route: AdminRoute): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const expected = route.body ?? 'json';
  if (expected === 'none') return true;
  const header = (request.headers.get('content-type') ?? '').toLowerCase();
  if (expected === 'multipart') return header.startsWith('multipart/form-data');
  // A DELETE declared as `json` may legitimately carry no body at all.
  if (header === '' && request.method === 'DELETE') return true;
  return header.startsWith('application/json');
}

/**
 * Run the guard.
 *
 * Note what happens on an unknown route: `ROUTE_UNKNOWN`, refused. A file added
 * under `src/pages/api/admin/` without a matching `ADMIN_ROUTES` entry is therefore
 * unreachable rather than unguarded, which is the fail-safe direction.
 */
export async function evaluateGuard(input: GuardInput): Promise<GuardOutcome> {
  const { request, sessions, expectedOrigin } = input;
  const now = input.now ?? Date.now();
  const url = new URL(request.url);

  const route = findAdminRoute(request.method, url.pathname);
  if (route === null) {
    return { ok: false, response: errorResponse(ERROR_CODES.ROUTE_UNKNOWN) };
  }

  // 1. Origin / Referer — before any storage access.
  if (!checkOrigin(request, expectedOrigin)) {
    return { ok: false, response: errorResponse(ERROR_CODES.ORIGIN_MISMATCH) };
  }

  // A public route stops here. `evaluateGuard` returns no session for it, so the
  // caller cannot accidentally treat the login handler as authenticated.
  if (route.auth.kind === 'public') {
    if (!checkContentType(request, route)) {
      return { ok: false, response: errorResponse(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE) };
    }
    return {
      ok: false,
      response: errorResponse(ERROR_CODES.ROUTE_UNKNOWN, {
        message: 'This endpoint is handled without the admin guard.',
      }),
    };
  }

  // 2. Session.
  const cookieId = readSessionCookie(request.headers.get('cookie'));
  const session = await readSession(sessions, cookieId, now);
  if (session === null) {
    return {
      ok: false,
      response: errorResponse(ERROR_CODES.UNAUTHENTICATED, {
        headers: { 'set-cookie': clearedSessionCookieValue() },
      }),
    };
  }

  // 3. CSRF double-submit, on unsafe methods.
  if (!SAFE_METHODS.has(request.method)) {
    const presented = request.headers.get(CSRF_HEADER) ?? '';
    if (presented === '' || !tokensMatch(presented, session.csrfToken)) {
      return { ok: false, response: errorResponse(ERROR_CODES.CSRF_INVALID) };
    }
  }

  // 4. Permission.
  if (route.auth.kind === 'permission' && !can(session.role, route.auth.permission)) {
    return { ok: false, response: errorResponse(ERROR_CODES.FORBIDDEN) };
  }

  // 4b. Content type.
  if (!checkContentType(request, route)) {
    return { ok: false, response: errorResponse(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE) };
  }

  // 5. Payload validation is step five, but it belongs to the handler: only the
  // handler knows its schema. `readValidatedJson` below is the sanctioned way, and
  // it is the only thing between the request body and any privileged call.
  const touched = await touchSession(sessions, session, now);
  return { ok: true, session: touched, route };
}

/**
 * The shape `requireAdmin` needs from an Astro `APIContext`.
 *
 * Structural, not `APIContext` itself, so the guard can be exercised without
 * constructing an Astro context. `locals` is `unknown` because nothing here reads it:
 * bindings come from `cloudflare:workers` via `src/lib/env.ts`.
 */
interface AstroLikeContext {
  request: Request;
  locals?: unknown;
}

/**
 * Astro-facing entry point.
 *
 * `permission` is accepted for symmetry with the design's signature and as a
 * belt-and-braces assertion, but it is **not** the source of truth: the requirement
 * comes from `ADMIN_ROUTES`. When a caller passes a permission that disagrees with
 * the table, both must pass — a handler can tighten its own access but never widen
 * it past its declaration.
 */
export async function requireAdmin(
  context: AstroLikeContext,
  permission?: Permission,
): Promise<GuardOutcome> {
  let sessions: KVNamespace;
  let expectedOrigin: string;
  try {
    sessions = getKV(context, 'SESSIONS');
    expectedOrigin = getPublicConfig(context).siteUrl;
  } catch {
    // A missing binding is a deployment fault, not an authorization decision, and
    // must not read as "allowed". Fail closed with a stable code and no detail.
    return { ok: false, response: errorResponse(ERROR_CODES.CONFIGURATION_INCOMPLETE) };
  }

  const outcome = await evaluateGuard({ request: context.request, sessions, expectedOrigin });
  if (!outcome.ok) return outcome;
  if (permission !== undefined && !can(outcome.session.role, permission)) {
    return { ok: false, response: errorResponse(ERROR_CODES.FORBIDDEN) };
  }
  return outcome;
}

/**
 * Step 5 — payload validation.
 *
 * Returns field-keyed errors in the same shape the publish gate produces, so the
 * admin form renders a 422 from either source identically. A body that is not JSON
 * at all is a validation failure, not a 500.
 */
export async function readValidatedJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: errorResponse(ERROR_CODES.VALIDATION_FAILED, {
        message: 'The request body was not valid JSON.',
      }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const fields: Record<string, string[]> = {};
  for (const problem of parsed.error.issues) {
    const key = problem.path.length > 0 ? problem.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [problem.message];
    else if (!bucket.includes(problem.message)) bucket.push(problem.message);
  }
  return { ok: false, response: errorResponse(ERROR_CODES.VALIDATION_FAILED, { fields }) };
}

/** The client address, as Cloudflare reports it. `unknown` keeps keys well-formed. */
export function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? 'unknown';
}
