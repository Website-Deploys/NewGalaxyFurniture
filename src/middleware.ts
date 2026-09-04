/**
 * Global middleware.
 *
 * Four jobs, all of which must happen ahead of any route handler:
 *
 * 0. **Canonicalise the URL.** A trailing slash, or a slug that has since been renamed, is answered
 *    with a single 301 to the canonical address before anything else runs — including the session
 *    check, because redirecting an unauthenticated request to a login page for a URL that is about
 *    to move is two round trips to reach one page (Requirements 12.11, 23.15, 23.16).
 *
 *    Prerendered HTML is served straight from Cloudflare's asset store and never reaches this
 *    function, so the static side of the same rule is configured at the edge:
 *    `html_handling = "drop-trailing-slash"` in `wrangler.toml` and the generated
 *    `dist/client/_redirects`. This implementation covers the Worker-served routes and `astro dev`.
 *
 * 0b. **Emit the security headers** on every response the Worker produces, from the single
 *    definition in `@/lib/security/headers`. `public/_headers` carries the same set for the assets
 *    the Worker never sees (Requirements 25.9, 25.10).
 *
 * 1. **Gate `/admin/**` pages.** An unauthenticated page request redirects to
 *    `/admin/login?next=<path>` and comes back to that path after login
 *    (Requirement 10.2). An expired session takes the identical path, so a session
 *    timing out mid-edit looks like a re-login, not an error.
 * 2. **Keep admin and preview surfaces out of search indexes.** `X-Robots-Tag` is
 *    set here rather than in each layout because a header covers API responses and
 *    redirects too, which a `<meta>` tag cannot (Requirements 11.5, 12.10).
 *
 * `/api/admin/**` is deliberately *not* gated here. Each endpoint calls
 * `requireAdmin`, which resolves the route's declared permission from
 * `ADMIN_ROUTES` — a decision this layer has no business duplicating, since a second
 * copy of an authorization rule is a second place for it to be wrong. What this
 * layer does add for the API is the per-session request ceiling, which is
 * cross-cutting and cheap.
 *
 * Design: Admin Authentication; Pages, Navigation, and States → Route inventory.
 * Requirements: 10.1, 10.2, 10.12, 11.5, 12.10, 25.4.
 */

import { defineMiddleware } from 'astro:middleware';

import { consumeBindingLimit } from '@/lib/auth/rate-limit';
import { ERROR_CODES, errorResponse, minutesPhrase } from '@/lib/errors';
import { getRedirects } from '@/lib/content/site';
import { getWorkerEnv } from '@/lib/env';
import { isAdminApiPath, isAdminPagePath, LOGIN_PAGE_PATH } from '@/lib/auth/routes';
import { readSessionCookie, readSession } from '@/lib/auth/session';
import { applySecurityHeaders } from '@/lib/security/headers';
import { canonicalRedirect } from '@/lib/seo/redirects';

const NOINDEX = 'noindex, nofollow';

function isPreviewPath(pathname: string): boolean {
  return pathname.startsWith('/admin/preview/');
}

/** Admin pages that must be reachable without a session. */
function isPublicAdminPage(pathname: string): boolean {
  return pathname === LOGIN_PAGE_PATH || pathname === `${LOGIN_PAGE_PATH}/`;
}

/** The Worker env, or null when this render has no Cloudflare runtime. */
function readEnvOrNull(
  context: Parameters<typeof getWorkerEnv>[0],
): ReturnType<typeof getWorkerEnv> | null {
  try {
    return getWorkerEnv(context);
  } catch {
    return null;
  }
}

/** The admin gate and the API ceiling. Wrapped by `onRequest`, which adds the cross-cutting parts. */
async function handle(
  context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
  next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
): Promise<Response> {
  const { pathname } = context.url;
  const adminPage = isAdminPagePath(pathname);
  const adminApi = isAdminApiPath(pathname);

  if (!adminPage && !adminApi) return await next();

  // Bindings are only present on on-demand-rendered routes. During the static build
  // this middleware still runs for prerendered pages, so a missing runtime must not
  // throw — it means "there is no session to read here", not "deny".
  const env = readEnvOrNull(context);

  if (adminApi) {
    // 120 requests / minute / session (Requirement 10.12). Keyed by the cookie
    // value, which is the session identity; an unauthenticated caller is keyed by
    // address instead so the ceiling cannot be dodged by omitting the cookie.
    const sessionId = readSessionCookie(context.request.headers.get('cookie'));
    const key =
      sessionId !== ''
        ? `admin-api:${sessionId}`
        : `admin-api-anon:${context.request.headers.get('cf-connecting-ip') ?? 'unknown'}`;
    const decision = await consumeBindingLimit(env?.RL_ADMIN_API, key);
    if (!decision.allowed) {
      return errorResponse(ERROR_CODES.RATE_LIMITED, {
        message: `Too many requests. Try again in ${minutesPhrase(decision.retryAfterMinutes)}.`,
        headers: { 'retry-after': String(decision.retryAfterMinutes * 60) },
      });
    }
    const response = await next();
    response.headers.set('x-robots-tag', NOINDEX);
    return response;
  }

  // --- Admin pages ----------------------------------------------------------
  if (!isPublicAdminPage(pathname)) {
    const sessions = env?.SESSIONS;
    const session =
      sessions === undefined
        ? null
        : await readSession(sessions, readSessionCookie(context.request.headers.get('cookie')));

    if (session === null) {
      const next_ = `${pathname}${context.url.search}`;
      // The redirect is itself an admin response, so it carries the admin response headers. It
      // would be easy to argue they are unnecessary on an empty 302 — robots.txt already disallows
      // `/admin`, and the destination is itself `noindex` — but "every response under /admin is
      // noindex and uncacheable" is a rule worth being able to state without an exception, and a
      // crawler that ignores robots.txt is exactly the one that will not read the exception either.
      const redirect = context.redirect(
        `${LOGIN_PAGE_PATH}?next=${encodeURIComponent(next_)}`,
        302,
      );
      redirect.headers.set('x-robots-tag', NOINDEX);
      redirect.headers.set('cache-control', 'no-store');
      return redirect;
    }
    // Handed to the page so `AdminLayout` can bootstrap the CSRF token and the nav
    // can hide controls the role lacks — without a second KV read per render.
    context.locals.adminSession = session;
  }

  const response = await next();
  response.headers.set('x-robots-tag', NOINDEX);
  if (isPreviewPath(pathname)) response.headers.set('cache-control', 'no-store');
  return response;
}

export const onRequest = defineMiddleware(async (context, next) => {
  /*
   * Before the session check: a URL that is about to move should move in one hop.
   *
   * **`isPrerendered` is load-bearing, not defensive.** This middleware also runs at *build* time,
   * once per prerendered route, and Astro renders those routes at their directory-format pathname —
   * `/collection/sofas/`, with the trailing slash. Without this guard the canonicaliser fires during
   * the build and every prerendered page is emitted as a redirect stub instead of a page: the build
   * succeeds, the site is empty, and nothing says why. (It did exactly that once, which is how the
   * guard came to be here.) Prerendered routes are served straight from Cloudflare's asset store at
   * runtime anyway, where `html_handling = "drop-trailing-slash"` and `_redirects` apply the same
   * rule — so skipping them here loses no coverage.
   */
  if (!context.isPrerendered) {
    const target = canonicalRedirect(context.url, getRedirects());
    if (target !== null) return applySecurityHeaders(context.redirect(target, 301));
  }

  return applySecurityHeaders(await handle(context, next));
});
