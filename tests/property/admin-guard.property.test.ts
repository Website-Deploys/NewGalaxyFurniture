import type { KVNamespace } from '@cloudflare/workers-types';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createSession } from '@/lib/auth/session';
import { CSRF_HEADER, evaluateGuard } from '@/lib/auth/guard';
import { ADMIN_ROUTES, routeKey, UNAUTHENTICATED_ROUTES, type AdminRoute } from '@/lib/auth/routes';
import { SESSION_COOKIE } from '@/lib/auth/session';

import { MemoryKV } from '../fixtures/github-api';
import { NUM_RUNS } from './config';

/**
 * Property 52: Unauthenticated admin requests write nothing.
 * Property 53: Missing or wrong CSRF tokens are refused.
 *
 * **Validates: Requirements 10.1, 10.8, 10.9, 10.14, 25.4**
 *
 * Both are stated over *every* admin endpoint, so both are driven by enumerating `ADMIN_ROUTES`
 * rather than by naming endpoints. That matters more than it looks: an endpoint added without a
 * table entry is unreachable (`evaluateGuard` answers `ROUTE_UNKNOWN`), so the table is the complete
 * list of admin surface, and enumerating it is enumerating the surface. A hand-written list of
 * endpoints in this file would be a second inventory to keep in step, and it would be the one that
 * silently fell behind.
 *
 * **On the spies.** The design's strategy for Property 52 asks for spies on the D1, GitHub and R2
 * bindings, asserted un-called. That is what the three fakes below are: every method that could
 * mutate state is a `vi.fn()`, they are handed to the guard's storage surface, and each property run
 * asserts none of them fired. The guarantee they establish is structural — the guard reaches its
 * refusal *before* any binding is touched, so there is no ordering in which a write could precede
 * the check. Handlers cannot bypass it: `requireAdmin` is their first statement and it returns a
 * `Response` on refusal, which is the value the endpoint returns.
 *
 * Design: Correctness Properties → Properties 52, 53; Admin Authentication.
 */

const ORIGIN = 'https://admin.example.test';

/** Every route that requires a session — the surface both properties quantify over. */
const GUARDED_ROUTES: AdminRoute[] = ADMIN_ROUTES.filter(
  (route) => !UNAUTHENTICATED_ROUTES.includes(routeKey(route)),
);

/** Routes with an unsafe method, which are the ones a CSRF token applies to. */
const UNSAFE_ROUTES: AdminRoute[] = GUARDED_ROUTES.filter(
  (route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method),
);

/** A concrete path for a route pattern: `:id` and `:slug` placeholders filled in. */
function pathFor(route: AdminRoute): string {
  return route.pattern
    .replace(/:id\b/g, 'p_abcdefghij')
    .replace(/:imageId\b/g, 'img_abcdefghij')
    .replace(/:slug\b/g, 'sofas')
    .replace(/\/\*+/g, '/sofas');
}

function contentTypeFor(route: AdminRoute): string | undefined {
  if (['GET', 'HEAD'].includes(route.method)) return undefined;
  if (route.body === 'multipart') return 'multipart/form-data; boundary=x';
  if (route.body === 'none') return undefined;
  return 'application/json';
}

function requestFor(
  route: AdminRoute,
  options: { cookie?: string; csrf?: string | null; body?: unknown } = {},
): Request {
  const headers = new Headers({ origin: ORIGIN });
  const contentType = contentTypeFor(route);
  if (contentType !== undefined) headers.set('content-type', contentType);
  if (options.cookie !== undefined) headers.set('cookie', options.cookie);
  if (options.csrf !== undefined && options.csrf !== null) {
    headers.set(CSRF_HEADER, options.csrf);
  }

  const method = route.method;
  const hasBody = !['GET', 'HEAD'].includes(method) && options.body !== undefined;
  return new Request(`${ORIGIN}${pathFor(route)}`, {
    method,
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Binding spies                                                              */
/* -------------------------------------------------------------------------- */

/** Every mutating entry point on the three bindings, as spies. */
function bindingSpies() {
  const d1 = {
    prepare: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
  };
  const r2 = {
    put: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
  };
  /** The GitHub write pipeline's only egress: `fetch`. A commit cannot happen without it. */
  const github = { fetch: vi.fn() };

  const all = [...Object.values(d1), ...Object.values(r2), ...Object.values(github)];
  return {
    d1,
    r2,
    github,
    expectNothingTouched(): void {
      for (const spy of all) expect(spy).not.toHaveBeenCalled();
    },
  };
}

/**
 * KV, wrapped so writes are observable.
 *
 * `SESSIONS` is the one binding the guard *does* read, because reading the session is the check. A
 * refused request must not write to it either — a `put` on an unauthenticated request would mean the
 * guard had created or extended something.
 */
function sessionStore(): { kv: KVNamespace; put: ReturnType<typeof vi.fn> } {
  const memory = new MemoryKV();
  const put = vi.fn(memory.put);
  return { kv: { ...memory, put } as unknown as KVNamespace, put };
}

/* -------------------------------------------------------------------------- */
/* Property 52                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 52: Unauthenticated admin requests write nothing', () => {
  it('answers 401 for every guarded route, with any body, and touches no binding', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...GUARDED_ROUTES), fc.jsonValue(), async (route, body) => {
        const spies = bindingSpies();
        const { kv, put } = sessionStore();

        const outcome = await evaluateGuard({
          request: requestFor(route, { body }),
          sessions: kv,
          expectedOrigin: ORIGIN,
        });

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.response.status).toBe(401);
        expect(await outcome.response.clone().json()).toMatchObject({
          error: 'UNAUTHENTICATED',
        });
        spies.expectNothingTouched();
        expect(put).not.toHaveBeenCalled();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('answers 401 for a cookie naming a session that does not exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...GUARDED_ROUTES),
        // A well-formed but unknown session id. `hexaString` was removed in fast-check 4.
        fc
          .uint8Array({ minLength: 8, maxLength: 32 })
          .map((bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
        async (route, sessionId) => {
          const spies = bindingSpies();
          const { kv } = sessionStore();

          const outcome = await evaluateGuard({
            request: requestFor(route, { cookie: `${SESSION_COOKIE}=${sessionId}` }),
            sessions: kv,
            expectedOrigin: ORIGIN,
          });

          expect(outcome.ok).toBe(false);
          if (!outcome.ok) expect(outcome.response.status).toBe(401);
          spies.expectNothingTouched();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('clears the session cookie on refusal, so an expired session does not loop', async () => {
    const { kv } = sessionStore();
    const route = GUARDED_ROUTES[0];
    expect(route).toBeDefined();
    if (route === undefined) return;

    const outcome = await evaluateGuard({
      request: requestFor(route),
      sessions: kv,
      expectedOrigin: ORIGIN,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
      expect(outcome.response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
  });

  it('covers the whole admin surface, so the enumeration is not accidentally narrow', () => {
    // Every route in the table except the login endpoint requires a session.
    expect(GUARDED_ROUTES.length).toBe(ADMIN_ROUTES.length - UNAUTHENTICATED_ROUTES.length);
    expect(GUARDED_ROUTES.length).toBeGreaterThan(20);
    expect(UNSAFE_ROUTES.length).toBeGreaterThan(10);
  });
});

/* -------------------------------------------------------------------------- */
/* Property 53                                                                */
/* -------------------------------------------------------------------------- */

describe('Property 53: Missing or wrong CSRF tokens are refused', () => {
  /** A real session in KV, plus the cookie that presents it. */
  async function withSession(kv: KVNamespace): Promise<{ cookie: string; csrfToken: string }> {
    const session = await createSession(kv, {
      userId: 'u_owner',
      role: 'owner',
      userAgent: 'test-agent',
    });
    return { cookie: `${SESSION_COOKIE}=${session.id}`, csrfToken: session.csrfToken };
  }

  it('answers 403 for every unsafe route when the token is missing or wrong', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...UNSAFE_ROUTES),
        // `null` is "header absent"; every string is a wrong token, excluded from being the real
        // one below.
        fc.option(fc.string({ maxLength: 80 }), { nil: null }),
        fc.jsonValue(),
        async (route, token, body) => {
          const spies = bindingSpies();
          const { kv } = sessionStore();
          const { cookie, csrfToken } = await withSession(kv);
          fc.pre(token !== csrfToken);

          const outcome = await evaluateGuard({
            request: requestFor(route, { cookie, csrf: token, body }),
            sessions: kv,
            expectedOrigin: ORIGIN,
          });

          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;
          expect(outcome.response.status).toBe(403);
          expect(await outcome.response.clone().json()).toMatchObject({ error: 'CSRF_INVALID' });
          spies.expectNothingTouched();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts the session’s own token, so the refusal is about the token and not the route', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...UNSAFE_ROUTES), async (route) => {
        const { kv } = sessionStore();
        const { cookie, csrfToken } = await withSession(kv);

        const outcome = await evaluateGuard({
          request: requestFor(route, { cookie, csrf: csrfToken, body: {} }),
          sessions: kv,
          expectedOrigin: ORIGIN,
        });

        // An owner holds every permission, so the only remaining refusal would be a content-type
        // mismatch — which `requestFor` supplies from the route's own declaration.
        expect(outcome.ok, `${route.method} ${route.pattern}`).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('refuses a token that differs only in length, so comparison is not a prefix match', async () => {
    const { kv } = sessionStore();
    const { cookie, csrfToken } = await withSession(kv);
    const route = UNSAFE_ROUTES[0];
    expect(route).toBeDefined();
    if (route === undefined) return;

    for (const wrong of [csrfToken.slice(0, -1), `${csrfToken}0`, csrfToken.toUpperCase()]) {
      if (wrong === csrfToken) continue;
      const outcome = await evaluateGuard({
        request: requestFor(route, { cookie, csrf: wrong, body: {} }),
        sessions: kv,
        expectedOrigin: ORIGIN,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.response.status).toBe(403);
    }
  });

  it('refuses an unsafe request from another origin before reading any session', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...UNSAFE_ROUTES), async (route) => {
        const spies = bindingSpies();
        const { kv } = sessionStore();
        const { cookie, csrfToken } = await withSession(kv);

        const request = requestFor(route, { cookie, csrf: csrfToken, body: {} });
        const headers = new Headers(request.headers);
        headers.set('origin', 'https://evil.test');
        const crossSite = new Request(request.url, { method: route.method, headers });

        const outcome = await evaluateGuard({
          request: crossSite,
          sessions: kv,
          expectedOrigin: ORIGIN,
        });

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.response.status).toBe(403);
          expect(await outcome.response.clone().json()).toMatchObject({
            error: 'ORIGIN_MISMATCH',
          });
        }
        spies.expectNothingTouched();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
