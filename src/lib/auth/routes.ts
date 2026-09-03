/**
 * The admin route table — the single declaration of what each admin API endpoint
 * requires.
 *
 * This exists so that "every endpoint declares a permission" is a structural fact
 * rather than a review habit. Two mechanisms enforce it:
 *
 * 1. **The type.** `AdminRouteAuth` is a discriminated union: an entry whose `kind`
 *    is `'permission'` cannot omit `permission`, so the compiler rejects a
 *    half-declared route.
 * 2. **Property 30.** Every entry must either carry a permission from the
 *    `Permission` union or appear in the closed `UNAUTHENTICATED_ROUTES` /
 *    `SESSION_ONLY_ROUTES` allowlists below. A new endpoint therefore cannot be
 *    added as "public" or "no permission needed" without editing an allowlist that
 *    the property test reads — which is a visible, reviewable act.
 *
 * The guard (`src/lib/auth/guard.ts`) resolves a request against this table; it
 * never takes a permission from the handler's own say-so. A request whose method
 * and path match no entry is refused, so an unlisted `/api/admin/**` file is
 * unreachable rather than unguarded.
 *
 * Design: Admin Authentication → Role model; Write Pipeline → Endpoint contracts.
 * Requirements: 10.1, 10.14, 10.15, 10.16.
 */

import type { Permission } from './permissions';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type AdminRouteAuth =
  /** No session required. Exactly one endpoint qualifies: the login handler itself. */
  | { kind: 'public' }
  /**
   * A valid session and a matching CSRF token, but no particular permission —
   * every authenticated role may end its own session and read its own identity.
   */
  | { kind: 'session' }
  /** A valid session, a matching CSRF token, and the named permission. */
  | { kind: 'permission'; permission: Permission };

export interface AdminRoute {
  readonly method: HttpMethod;
  /** Human-readable pattern, `:param` for segments. Also the table's identity. */
  readonly pattern: string;
  /** Anchored matcher compiled from `pattern`. */
  readonly match: RegExp;
  readonly auth: AdminRouteAuth;
  /**
   * `application/json` is required on every unsafe method except the image upload,
   * which is necessarily multipart and is marked here rather than special-cased
   * inside the guard.
   */
  readonly body?: 'json' | 'multipart' | 'none';
}

/** `:param` matches one path segment; nothing matches across a `/`. */
function compile(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`),
    )
    .join('/');
  return new RegExp(`^${source}/?$`);
}

function route(
  method: HttpMethod,
  pattern: string,
  auth: AdminRouteAuth,
  body: AdminRoute['body'] = method === 'GET' || method === 'DELETE' ? 'none' : 'json',
): AdminRoute {
  return { method, pattern, match: compile(pattern), auth, body };
}

const permission = (value: Permission): AdminRouteAuth => ({
  kind: 'permission',
  permission: value,
});
const sessionOnly: AdminRouteAuth = { kind: 'session' };
const publicRoute: AdminRouteAuth = { kind: 'public' };

/**
 * `product.read` serves as the general admin read permission.
 *
 * The design's `Permission` union has no `settings.read` or `homepage.read`, and
 * inventing one would put this table out of step with the design. Mapping settings
 * and homepage reads onto `settings.write` would be worse: it would stop a viewer
 * from seeing configuration they are explicitly allowed to observe. Reads are
 * therefore `product.read` — "may look at admin content" — and every write keeps
 * its specific permission.
 */
const READ = permission('product.read');

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  // --- Auth -----------------------------------------------------------------
  route('POST', '/api/admin/login', publicRoute),
  route('POST', '/api/admin/logout', sessionOnly),
  route('GET', '/api/admin/session', sessionOnly),

  // --- Products -------------------------------------------------------------
  route('GET', '/api/admin/products', READ),
  route('POST', '/api/admin/products', permission('product.write')),
  route('GET', '/api/admin/products/:id', READ),
  route('PATCH', '/api/admin/products/:id', permission('product.write')),
  route('DELETE', '/api/admin/products/:id', permission('product.delete'), 'json'),
  // `product.write`, not `product.publish`: an editor may move a product between
  // DRAFT and REVIEW. The publish-specific check is `canTransition`, which requires
  // `product.publish` for the PUBLISHED and OUT_OF_STOCK targets. Putting
  // `product.publish` here instead would block the legitimate editor workflow.
  route('POST', '/api/admin/products/:id/transition', permission('product.write')),
  route('POST', '/api/admin/products/:id/duplicate', permission('product.write')),

  // --- Images ---------------------------------------------------------------
  route('POST', '/api/admin/products/:id/images', permission('product.write'), 'multipart'),
  route('PATCH', '/api/admin/products/:id/images/order', permission('product.write')),
  route('PATCH', '/api/admin/products/:id/images/:imageId', permission('product.write')),
  route('DELETE', '/api/admin/products/:id/images/:imageId', permission('product.write')),

  // --- Categories -----------------------------------------------------------
  route('GET', '/api/admin/categories', READ),
  route('POST', '/api/admin/categories', permission('settings.write')),
  route('GET', '/api/admin/categories/:slug', READ),
  // Reordering is a `PATCH` on the *collection*, not a sequence of per-record edits: the
  // whole ordering moves in one commit, so the repository is never left with two
  // categories claiming the same position (Requirement 17.16).
  route('PATCH', '/api/admin/categories', permission('settings.write')),
  route('PATCH', '/api/admin/categories/:slug', permission('settings.write')),
  route('DELETE', '/api/admin/categories/:slug', permission('settings.write'), 'json'),

  // --- Reviews --------------------------------------------------------------
  route('GET', '/api/admin/reviews', READ),
  route('POST', '/api/admin/reviews', permission('review.write')),
  route('GET', '/api/admin/reviews/:id', READ),
  route('PATCH', '/api/admin/reviews', permission('review.write')),
  route('PATCH', '/api/admin/reviews/:id', permission('review.write')),
  // Removing a review changes what visitors read, so it sits with the publishing
  // permission rather than with authoring.
  route('DELETE', '/api/admin/reviews/:id', permission('review.publish'), 'json'),

  // --- Settings and homepage ------------------------------------------------
  route('GET', '/api/admin/settings', READ),
  route('PATCH', '/api/admin/settings', permission('settings.write')),
  route('GET', '/api/admin/homepage', READ),
  route('PATCH', '/api/admin/homepage', permission('settings.write')),

  // --- AI -------------------------------------------------------------------
  route('POST', '/api/admin/ai/generate', permission('ai.generate')),

  // --- Leads and analytics --------------------------------------------------
  route('GET', '/api/admin/leads', permission('lead.read')),
  route('PATCH', '/api/admin/leads/:id', permission('lead.write')),
  // The quarantined enquiry attachment. `lead.read`, because seeing the photograph a customer
  // sent is part of reading the lead — and this route is the *only* way to see it: there is no
  // public delivery path for the `quarantine/` prefix (Requirement 6.11).
  route('GET', '/api/admin/leads/:id/image', permission('lead.read')),
  route('GET', '/api/admin/analytics', permission('analytics.read')),

  // --- Pipeline operations --------------------------------------------------
  route('GET', '/api/admin/deploy-status', READ),
  route('POST', '/api/admin/rehydrate', permission('product.write')),
];

/**
 * The closed allowlist of endpoints that may run without a session. It has exactly
 * one member and there is no second candidate: everything else in `/api/admin/**`
 * is reachable only after `POST /api/admin/login` has succeeded.
 */
export const UNAUTHENTICATED_ROUTES: readonly string[] = ['POST /api/admin/login'];

/**
 * The closed allowlist of endpoints that require a session but no permission.
 * Both are operations on the caller's own session, which every role holds by
 * definition of having one.
 */
export const SESSION_ONLY_ROUTES: readonly string[] = [
  'POST /api/admin/logout',
  'GET /api/admin/session',
];

/** `"POST /api/admin/login"` — the key the two allowlists above are written in. */
export function routeKey(route: Pick<AdminRoute, 'method' | 'pattern'>): string {
  return `${route.method} ${route.pattern}`;
}

/**
 * Resolve a request to its declared route.
 *
 * Returns null when nothing matches, which the guard turns into a refusal. That is
 * the important half of this function: an endpoint file that exists but was never
 * added to the table above is unreachable, not unguarded.
 */
export function findAdminRoute(method: string, pathname: string): AdminRoute | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const candidate of ADMIN_ROUTES) {
    if (candidate.method === method && candidate.match.test(normalized)) return candidate;
  }
  return null;
}

/** True for a path the admin guard owns. */
export function isAdminApiPath(pathname: string): boolean {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

/** True for an admin page path (as opposed to an admin API path). */
export function isAdminPagePath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** The one admin page reachable without a session. */
export const LOGIN_PAGE_PATH = '/admin/login';
