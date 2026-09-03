import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  can,
  MUTATING_PERMISSIONS,
  PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  type Permission,
} from '@/lib/auth/permissions';
import {
  ADMIN_ROUTES,
  routeKey,
  SESSION_ONLY_ROUTES,
  UNAUTHENTICATED_ROUTES,
} from '@/lib/auth/routes';
import { assertProperty } from './config';

/**
 * Properties 29 and 30 — the permission model and the route table.
 *
 * Both are exhaustive rather than sampled, because both quantify over finite sets the
 * codebase declares: three roles, twelve permissions, and however many admin routes
 * exist. Sampling a set you can enumerate is strictly worse, so `fc.constantFrom` over
 * the real tables is used where the design's strategy says "exhaustive", and every
 * member is additionally visited directly so a shrinking arbitrary cannot mask a gap.
 *
 * Design → Correctness Properties → Properties 29, 30.
 */

const permissionArb = fc.constantFrom(...PERMISSIONS);

describe('Property 29: Viewers hold no mutating permission', () => {
  /**
   * A precondition on the property itself, not a separate claim: if a permission were
   * in neither classification, the assertion below would skip it silently and the
   * property would be vacuous for that permission. Adding a permission without
   * classifying it therefore fails here rather than quietly reaching a viewer.
   */
  it('classifies every permission as either mutating or read-only', () => {
    const classified = new Set<Permission>([...MUTATING_PERMISSIONS, ...READ_ONLY_PERMISSIONS]);
    expect([...classified].sort()).toEqual([...PERMISSIONS].sort());
    expect(classified.size).toBe(PERMISSIONS.length);
    for (const permission of MUTATING_PERMISSIONS) {
      expect(READ_ONLY_PERMISSIONS).not.toContain(permission);
    }
  });

  it('grants a viewer no permission from the mutating set', () => {
    assertProperty(
      fc.property(fc.constantFrom(...MUTATING_PERMISSIONS), (permission) => {
        expect(can('viewer', permission)).toBe(false);
      }),
      // Exhaustive by construction: the set has nine members.
      { numRuns: MUTATING_PERMISSIONS.length * 4 },
    );

    // And directly, so the assertion above cannot be satisfied by a lucky sample.
    for (const permission of MUTATING_PERMISSIONS) {
      expect(can('viewer', permission)).toBe(false);
    }
  });

  it('grants a viewer only permissions drawn from the read-only set', () => {
    assertProperty(
      fc.property(permissionArb, (permission) => {
        if (can('viewer', permission)) {
          expect(READ_ONLY_PERMISSIONS).toContain(permission);
        }
      }),
    );
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(READ_ONLY_PERMISSIONS).toContain(permission);
    }
  });

  it('denies an unknown role every permission', () => {
    assertProperty(
      fc.property(fc.string(), permissionArb, (role, permission) => {
        if ((ROLES as readonly string[]).includes(role)) return;
        // `can` is typed against `Role`, but the role arrives from a stored session
        // record and a corrupt one must grant nothing rather than everything.
        expect(can(role as never, permission)).toBe(false);
      }),
    );
  });

  it('keeps owner total and editor strictly between viewer and owner', () => {
    assertProperty(
      fc.property(permissionArb, (permission) => {
        // The owner is the seeded account and holds the whole union.
        expect(can('owner', permission)).toBe(true);
        // Containment: anything a viewer may do, an editor may do.
        if (can('viewer', permission)) expect(can('editor', permission)).toBe(true);
      }),
    );
    // Strictness in both directions, so the three roles are genuinely distinct and
    // the table has not collapsed into two.
    expect(ROLE_PERMISSIONS.editor.size).toBeGreaterThan(ROLE_PERMISSIONS.viewer.size);
    expect(ROLE_PERMISSIONS.owner.size).toBeGreaterThan(ROLE_PERMISSIONS.editor.size);
    // An editor may not publish or delete — that is the point of the role.
    expect(can('editor', 'product.publish')).toBe(false);
    expect(can('editor', 'product.delete')).toBe(false);
    expect(can('editor', 'settings.write')).toBe(false);
    expect(can('editor', 'user.manage')).toBe(false);
  });
});

describe('Property 30: Every admin route declares a permission', () => {
  it('declares a permission on every route outside the two closed allowlists', () => {
    expect(ADMIN_ROUTES.length).toBeGreaterThan(0);

    assertProperty(
      fc.property(fc.constantFrom(...ADMIN_ROUTES), (route) => {
        const key = routeKey(route);
        switch (route.auth.kind) {
          case 'permission':
            // The declared permission must be a real member of the union — a typo'd
            // string would type-check nowhere else but would deny everyone at runtime.
            expect(PERMISSIONS).toContain(route.auth.permission);
            expect(route.auth.permission).not.toBe('');
            return;
          case 'session':
            expect(SESSION_ONLY_ROUTES).toContain(key);
            return;
          case 'public':
            expect(UNAUTHENTICATED_ROUTES).toContain(key);
            return;
        }
      }),
      { numRuns: Math.max(300, ADMIN_ROUTES.length * 8) },
    );

    // Exhaustively, not just by sampling.
    for (const route of ADMIN_ROUTES) {
      const key = routeKey(route);
      if (route.auth.kind === 'permission') {
        expect(PERMISSIONS).toContain(route.auth.permission);
      } else if (route.auth.kind === 'session') {
        expect(SESSION_ONLY_ROUTES).toContain(key);
      } else {
        expect(UNAUTHENTICATED_ROUTES).toContain(key);
      }
    }
  });

  it('keeps the unauthenticated allowlist to exactly the login endpoint', () => {
    // The escape hatch has to stay narrow, or "every route declares a permission"
    // becomes true while meaning nothing. Widening it is a visible edit to this test.
    expect(UNAUTHENTICATED_ROUTES).toEqual(['POST /api/admin/login']);
    const publicRoutes = ADMIN_ROUTES.filter((route) => route.auth.kind === 'public');
    expect(publicRoutes.map(routeKey)).toEqual(['POST /api/admin/login']);
  });

  it('keeps the session-only allowlist to operations on the caller’s own session', () => {
    expect([...SESSION_ONLY_ROUTES].sort()).toEqual([
      'GET /api/admin/session',
      'POST /api/admin/logout',
    ]);
    const sessionRoutes = ADMIN_ROUTES.filter((route) => route.auth.kind === 'session');
    expect(sessionRoutes.map(routeKey).sort()).toEqual([...SESSION_ONLY_ROUTES].sort());
  });

  it('declares each method/pattern pair exactly once', () => {
    // Two entries for one pair would make the guard's first-match win silently, and
    // the losing entry's permission would never be enforced.
    const keys = ADMIN_ROUTES.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('scopes every declared route under /api/admin/', () => {
    for (const route of ADMIN_ROUTES) {
      expect(route.pattern.startsWith('/api/admin/')).toBe(true);
    }
  });

  it('gives every mutating route a permission a viewer does not hold', () => {
    // The structural version of Requirement 10.16: a viewer must not be able to reach
    // any state-changing endpoint, which is a stronger statement than "a viewer holds
    // no mutating permission" because it also catches a mutating route mapped onto a
    // read permission by mistake.
    const unsafe = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
    for (const route of ADMIN_ROUTES) {
      if (!unsafe.has(route.method)) continue;
      if (route.auth.kind !== 'permission') continue;
      expect(can('viewer', route.auth.permission)).toBe(false);
    }
  });
});
