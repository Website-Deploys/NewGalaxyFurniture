import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ROLES, can, type Role } from '@/lib/auth/permissions';
import {
  PUBLIC_TARGET_STATUSES,
  TRANSITIONS,
  applyTransition,
  availableTransitions,
  canTransition,
} from '@/lib/products/transitions';
import { ProductStatus, type Product, type ProductStatusValue } from '@/schemas/product';
import { checkPublishGate } from '@/schemas/publish-gate';
import type { InteractiveActor } from '@/lib/auth/actor';
import { assertProperty } from './config';
import { validProductArb } from './arbitraries';

/**
 * Properties 25–28 — the transition machine and the publish gate.
 *
 * 25–27 quantify over finite sets (five statuses × five statuses × three roles = 75
 * combinations), so they are asserted both through fast-check, as the design specifies,
 * and by direct enumeration of the whole product space. A property over an enumerable
 * domain should be *proved* on that domain, not sampled from it; the fast-check pass is
 * kept because it is what the design names and because it shrinks usefully if the table
 * changes.
 *
 * Property 28 is the interesting one: it is a stateful claim about *sequences*, and it
 * is the assertion that stops "publish an incomplete product" being reachable by a
 * roundabout route rather than only by the direct one.
 *
 * Design → Correctness Properties → Properties 25, 26, 27, 28.
 */

const STATUSES = ProductStatus.options;
const statusArb = fc.constantFrom(...STATUSES);
const roleArb = fc.constantFrom(...ROLES);

/**
 * The witness `applyTransition` requires. Constructed by cast *in the test only*: in
 * production the sole constructor is `interactiveActor(session, email)`, which needs a
 * live session. Reaching for the cast here is exactly the friction the brand is meant
 * to create — a caller that is not a request handler has to go out of its way.
 */
function actorFor(role: Role): InteractiveActor {
  return {
    email: 'operator@example.test',
    role,
    sessionId: 'sess_test',
  } as unknown as InteractiveActor;
}

/** Every (from, to, role) triple. */
function allTriples(): { from: ProductStatusValue; to: ProductStatusValue; role: Role }[] {
  const triples: { from: ProductStatusValue; to: ProductStatusValue; role: Role }[] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const role of ROLES) triples.push({ from, to, role });
    }
  }
  return triples;
}

describe('Property 25: There are no self-transitions', () => {
  it('refuses every status to itself, for every role', () => {
    assertProperty(
      fc.property(statusArb, roleArb, (status, role) => {
        expect(canTransition(status, status, role)).toBe(false);
      }),
    );

    for (const status of STATUSES) {
      for (const role of ROLES) {
        expect(canTransition(status, status, role), `${status} → ${status} as ${role}`).toBe(false);
      }
    }
  });

  it('declares no status as reachable from itself in the table', () => {
    // Belt and braces: `canTransition` could refuse a self-transition while the table
    // still declared one, and a future reader of `TRANSITIONS` would be misled.
    for (const status of STATUSES) {
      expect(TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('never offers a self-transition in the UI list', () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        expect(availableTransitions(status, role)).not.toContain(status);
      }
    }
  });
});

describe('Property 26: Transitions respect the declared machine', () => {
  it('permits only targets declared reachable from the source', () => {
    assertProperty(
      fc.property(statusArb, statusArb, roleArb, (from, to, role) => {
        if (canTransition(from, to, role)) {
          expect(TRANSITIONS[from]).toContain(to);
        }
      }),
    );

    for (const { from, to, role } of allTriples()) {
      if (canTransition(from, to, role)) expect(TRANSITIONS[from]).toContain(to);
    }
  });

  it('refuses a status string the machine does not declare', () => {
    assertProperty(
      fc.property(fc.string(), statusArb, roleArb, (unknown, known, role) => {
        if ((STATUSES as readonly string[]).includes(unknown)) return;
        const bogus = unknown as ProductStatusValue;
        // Neither direction may be traversable: a corrupt stored status must be a dead
        // end, not a wildcard.
        expect(canTransition(known, bogus, role)).toBe(false);
        expect(canTransition(bogus, known, role)).toBe(false);
      }),
    );
  });

  it('matches the design’s table exactly', () => {
    // The table is transcribed from the design, so it is worth asserting the
    // transcription rather than trusting it.
    expect(TRANSITIONS).toEqual({
      DRAFT: ['REVIEW', 'PUBLISHED'],
      REVIEW: ['DRAFT', 'PUBLISHED'],
      PUBLISHED: ['UNPUBLISHED', 'OUT_OF_STOCK', 'DRAFT'],
      OUT_OF_STOCK: ['PUBLISHED', 'UNPUBLISHED'],
      UNPUBLISHED: ['PUBLISHED', 'DRAFT'],
    });
  });

  it('is exactly the intersection of the table and the permission rule', () => {
    // The strongest form of 26: `canTransition` is not merely a subset of the table, it
    // is precisely "declared AND permitted AND not a self-transition". A weaker
    // implementation that refused legitimate transitions would satisfy the subset
    // direction and fail here.
    for (const { from, to, role } of allTriples()) {
      const declared = from !== to && TRANSITIONS[from].includes(to);
      const permitted = !PUBLIC_TARGET_STATUSES.includes(to) || can(role, 'product.publish');
      expect(canTransition(from, to, role)).toBe(declared && permitted);
    }
  });
});

describe('Property 27: Reaching a public state requires publish permission', () => {
  it('permits no public target without product.publish', () => {
    assertProperty(
      fc.property(
        statusArb,
        fc.constantFrom(...PUBLIC_TARGET_STATUSES),
        roleArb,
        (from, to, role) => {
          if (canTransition(from, to, role)) {
            expect(can(role, 'product.publish')).toBe(true);
          }
        },
      ),
    );

    for (const from of STATUSES) {
      for (const to of PUBLIC_TARGET_STATUSES) {
        for (const role of ROLES) {
          if (canTransition(from, to, role)) expect(can(role, 'product.publish')).toBe(true);
        }
      }
    }
  });

  it('blocks editors and viewers from every public target, from every source', () => {
    for (const role of ['editor', 'viewer'] as const) {
      expect(can(role, 'product.publish')).toBe(false);
      for (const from of STATUSES) {
        for (const to of PUBLIC_TARGET_STATUSES) {
          expect(canTransition(from, to, role), `${from} → ${to} as ${role}`).toBe(false);
        }
      }
      // And no public status is ever offered to them in the UI.
      for (const from of STATUSES) {
        for (const to of availableTransitions(from, role)) {
          expect(PUBLIC_TARGET_STATUSES).not.toContain(to);
        }
      }
    }
  });

  it('still allows an editor the draft/review half of the workflow', () => {
    // The property must not be satisfied by locking editors out entirely — that would
    // make the role useless and would hide a real regression.
    expect(canTransition('DRAFT', 'REVIEW', 'editor')).toBe(true);
    expect(canTransition('REVIEW', 'DRAFT', 'editor')).toBe(true);
    expect(availableTransitions('DRAFT', 'editor')).toEqual(['REVIEW']);
  });
});

describe('Property 28: No transition sequence can publish an incomplete product', () => {
  /**
   * A product that is schema-valid — so it can exist and be transitioned — but fails
   * the publish gate. `images: []` is the cleanest such hole: the base schema defaults
   * it to empty, and the gate requires at least one.
   */
  const incompleteProductArb: fc.Arbitrary<Product> = validProductArb
    .map((product): Product => {
      const { primaryImage: _primaryImage, ...rest } = product;
      return {
        ...rest,
        images: [],
        // Start somewhere non-public so the starting state is not already a violation.
        status: 'DRAFT',
        published: false,
        stockStatus: product.stockStatus === 'OUT_OF_STOCK' ? 'IN_STOCK' : product.stockStatus,
      };
    })
    .filter((product) => !checkPublishGate(product).ok);

  it('never reaches a public status through any sequence of transition calls', () => {
    assertProperty(
      fc.property(
        incompleteProductArb,
        roleArb,
        fc.array(statusArb, { minLength: 1, maxLength: 24 }),
        (start, role, commands) => {
          const actor = actorFor(role);
          let current = start;

          for (const target of commands) {
            const result = applyTransition(current, target, actor, {
              at: '2026-01-15T09:00:00.000Z',
            });
            // Advance only on success: a refused transition leaves the product exactly
            // as it was, which is also the behaviour the retry path depends on.
            if (result.ok) current = result.product;

            // The invariant, checked after every single step rather than only at the
            // end — a momentary public state would be a live incomplete product no
            // matter what the sequence did next.
            expect(PUBLIC_TARGET_STATUSES).not.toContain(current.status);
            expect(current.published).toBe(false);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('reports the gate failure against the field that failed', () => {
    assertProperty(
      fc.property(incompleteProductArb, (start) => {
        // The owner holds publish permission, so reachability and permission both pass
        // and the *only* thing refusing is the gate. That isolates the third gate.
        const result = applyTransition(start, 'PUBLISHED', actorFor('owner'), {
          at: '2026-01-15T09:00:00.000Z',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('PUBLISH_GATE_FAILED');
        if (result.code !== 'PUBLISH_GATE_FAILED') return;
        // Field-keyed, not a bare sentence (Requirement 14.5).
        expect(Object.keys(result.fields).length).toBeGreaterThan(0);
        expect(result.fields.images).toBeDefined();
      }),
    );
  });

  it('never mutates the product it was given', () => {
    assertProperty(
      fc.property(validProductArb, statusArb, roleArb, (product, to, role) => {
        const before = JSON.stringify(product);
        applyTransition(product, to, actorFor(role), { at: '2026-01-15T09:00:00.000Z' });
        // Requirement 17.17: a failed write must retain the operator's values, which is
        // only possible if the attempt left them alone.
        expect(JSON.stringify(product)).toBe(before);
      }),
    );
  });

  it('lets a complete product through, so the gate is not simply refusing everything', () => {
    const completeArb = validProductArb
      .filter((product) => product.images.length > 0)
      .map((product): Product => ({
        ...product,
        status: 'DRAFT',
        published: false,
        stockStatus: product.stockStatus === 'OUT_OF_STOCK' ? 'IN_STOCK' : product.stockStatus,
        images: product.images.map((image) => ({ ...image, alt: 'A photograph of the product' })),
      }))
      .filter(
        (product) => checkPublishGate({ ...product, status: 'PUBLISHED', published: true }).ok,
      );

    assertProperty(
      fc.property(completeArb, (product) => {
        const result = applyTransition(product, 'PUBLISHED', actorFor('owner'), {
          at: '2026-01-15T09:00:00.000Z',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.product.status).toBe('PUBLISHED');
        // The derived mirror is maintained by the transition, never by the caller.
        expect(result.product.published).toBe(true);
        expect(result.product.updatedAt).toBe('2026-01-15T09:00:00.000Z');
      }),
      { numRuns: 200 },
    );
  });

  it('keeps status and stock status coupled in both directions', () => {
    const publishableArb = validProductArb
      .filter((product) => product.images.length > 0 && !product.madeToOrder)
      .map((product): Product => ({
        ...product,
        status: 'PUBLISHED',
        published: true,
        stockStatus: 'IN_STOCK',
        images: product.images.map((image) => ({ ...image, alt: 'A photograph of the product' })),
      }))
      .filter((product) => checkPublishGate(product).ok);

    assertProperty(
      fc.property(publishableArb, (product) => {
        const out = applyTransition(product, 'OUT_OF_STOCK', actorFor('owner'), {
          at: '2026-01-15T09:00:00.000Z',
        });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        // The schema requires the biconditional; the transition must satisfy it rather
        // than emit a record its own schema rejects.
        expect(out.product.stockStatus).toBe('OUT_OF_STOCK');
        expect(checkPublishGate(out.product).ok).toBe(true);

        const back = applyTransition(out.product, 'PUBLISHED', actorFor('owner'), {
          at: '2026-01-15T10:00:00.000Z',
        });
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        expect(back.product.stockStatus).not.toBe('OUT_OF_STOCK');
        expect(checkPublishGate(back.product).ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
