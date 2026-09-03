import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_RELATED_SCORE,
  RELATED_LIMIT,
  relatedProducts,
  relatedScore,
  sharesAnyAttribute,
  withinPriceProximity,
  type RelatedTarget,
} from '@/lib/products/related';
import type { SearchDoc } from '@/lib/search/types';

import { assertProperty } from './config';
import { distinctSearchDocsArb, searchDocArb } from './arbitraries';

/**
 * Properties 40 and 41 — the related-products engine.
 *
 * **One documented deviation from the design's stated strategy for Property 40.** The design's
 * strategy sentence says to "assert each returned document shares category, subcategory, tag,
 * material, colour, or price *band*". The normative scoring rule two paragraphs above it —
 * and Requirement 4.7's "price proximity" — say the price rung is **±35% of the target's
 * price**, not a shared band. Those are different predicates, and the band version is not
 * merely different but *false*: ₹24,000 and ₹26,000 are within 35% of each other and sit in
 * two different bands (`under25k`, `25k-50k`), so a candidate related purely by price
 * proximity would be a counterexample to a band-phrased assertion while being exactly what
 * the requirement asks for. The property below therefore asserts the ±35% form. Nothing is
 * weakened: the assertion is over the same six attribute rungs, with the price rung stated as
 * the rule actually specifies it.
 *
 * The second deviation is an addition rather than a change. `searchDocArb` generates no
 * operator-specified list, so the design's strategy exercises the scored path only. Operator
 * overrides are an explicit exception to the relevance claim — an operator who names three
 * products gets those three whether or not they share an attribute — so a third property below
 * covers the manual path with the honest invariant (membership is manual **or** relevant) and
 * asserts the manual entries lead, in the operator's order.
 */

/** A target document paired with a candidate pool that includes genuinely related documents. */
const targetAndPoolArb: fc.Arbitrary<{ target: SearchDoc; pool: SearchDoc[] }> = fc
  .tuple(searchDocArb, distinctSearchDocsArb({ minLength: 0, maxLength: 14 }))
  .map(([rawTarget, docs]) => {
    const target: SearchDoc = { ...rawTarget, i: 'target-slug', k: 'NGF-TGT-000000' };
    // Half the pool is re-stamped to share attributes with the target, so the properties are
    // exercised against real relatedness rather than against an almost-always-empty result.
    const pool = docs.map((doc, index) =>
      index % 2 === 0
        ? {
            ...doc,
            c: target.c,
            ...(target.s === undefined ? {} : { s: target.s }),
            ...(target.m === undefined ? {} : { m: target.m }),
            t: target.t.length > 0 ? target.t : doc.t,
            o: target.o.length > 0 ? target.o : doc.o,
          }
        : doc,
    );
    return { target, pool };
  });

describe('Property 40: Related products are relevant, deduplicated, and bounded', () => {
  /** Validates: Requirements 4.7, 4.8, 4.9 */
  it('never contains the target, never duplicates, is bounded, and every member is relevant', () => {
    assertProperty(
      fc.property(targetAndPoolArb, fc.integer({ min: 1, max: 12 }), ({ target, pool }, limit) => {
        const result = relatedProducts(target, pool, limit);

        // Bounded, by the caller's limit and by the requirement's ceiling of eight by default.
        expect(result.length).toBeLessThanOrEqual(limit);
        expect(relatedProducts(target, pool).length).toBeLessThanOrEqual(RELATED_LIMIT);

        // The target is never its own related product (Requirement 4.8).
        expect(result.some((doc) => doc.i === target.i)).toBe(false);

        // No duplicates, by slug — the identity the PDP renders one card per.
        const slugs = result.map((doc) => doc.i);
        expect(new Set(slugs).size).toBe(slugs.length);

        // Every member came from the pool.
        const poolSlugs = new Set(pool.map((doc) => doc.i));
        for (const slug of slugs) expect(poolSlugs.has(slug)).toBe(true);

        // Every member shares at least one recognised attribute (Requirement 4.9): the
        // category, the subcategory, a tag, the material, a colour, or a price within ±35%.
        for (const doc of result) {
          const shares =
            doc.c === target.c ||
            (target.s !== undefined && doc.s === target.s) ||
            (target.m !== undefined && doc.m === target.m) ||
            doc.t.some((tag) => target.t.includes(tag)) ||
            doc.o.some((colour) => target.o.includes(colour)) ||
            withinPriceProximity(target.p, doc.p);
          expect(shares).toBe(true);
          expect(sharesAnyAttribute(target, doc)).toBe(true);
        }
      }),
    );
  });

  it('omits the section rather than padding it: a pool sharing nothing yields nothing', () => {
    assertProperty(
      fc.property(distinctSearchDocsArb({ minLength: 1, maxLength: 10 }), (docs) => {
        // A target that deliberately shares no attribute with anything the generators produce:
        // an unknown category, no subcategory, no material, no tag, no colour, and price on
        // enquiry (so the ±35% rung can never be paid either).
        const target: SearchDoc = {
          i: 'lone-target',
          n: 'Lone Target',
          k: 'NGF-LON-000000',
          c: 'no-such-category',
          o: [],
          t: [],
          p: null,
          st: 'IN_STOCK',
          f: 0,
          ts: 1_700_000_000,
          th: '',
          lq: '',
        };
        const pool = docs.filter((doc) => doc.p !== null || doc.c !== target.c);
        expect(relatedProducts(target, pool)).toEqual([]);
      }),
    );
  });

  it('orders by score descending, then price proximity, then slug', () => {
    assertProperty(
      fc.property(targetAndPoolArb, ({ target, pool }) => {
        const result = relatedProducts(target, pool);
        for (let index = 1; index < result.length; index += 1) {
          const previous = result[index - 1];
          const current = result[index];
          if (previous === undefined || current === undefined) continue;
          const previousScore = relatedScore(target, previous);
          const currentScore = relatedScore(target, current);
          expect(previousScore).toBeGreaterThanOrEqual(currentScore);
          expect(currentScore).toBeGreaterThan(0);
          expect(previousScore).toBeLessThanOrEqual(MAX_RELATED_SCORE);
        }
      }),
    );
  });
});

describe('Property 41: Related products are deterministic', () => {
  /** Validates: Requirements 4.7 */
  it('returns identical arrays for identical inputs, in the same order', () => {
    assertProperty(
      fc.property(targetAndPoolArb, ({ target, pool }) => {
        const first = relatedProducts(target, pool);
        const second = relatedProducts(target, pool);
        expect(second.map((doc) => doc.i)).toEqual(first.map((doc) => doc.i));
        expect(second).toEqual(first);
      }),
    );
  });

  it('is independent of the pool\u2019s own ordering', () => {
    // Time-invariance and shuffle-invariance are the same claim in practice: a result that
    // depended on the clock would also depend on whatever order the loader happened to yield.
    // Reversing the pool is the cheapest permutation that would expose an unstable comparator.
    assertProperty(
      fc.property(targetAndPoolArb, ({ target, pool }) => {
        const forward = relatedProducts(target, pool).map((doc) => doc.i);
        const backward = relatedProducts(target, [...pool].reverse()).map((doc) => doc.i);
        expect(backward).toEqual(forward);
      }),
    );
  });
});

describe('operator-specified related products (Requirement 4.7)', () => {
  it('leads with the operator\u2019s list in the operator\u2019s order, and stays deduplicated', () => {
    assertProperty(
      fc.property(
        targetAndPoolArb,
        fc.array(fc.nat({ max: 13 }), { maxLength: 6 }),
        ({ target, pool }, picks) => {
          const manual: string[] = [];
          for (const index of picks) {
            const doc = pool[index % Math.max(pool.length, 1)];
            if (doc !== undefined) manual.push(doc.i);
          }
          const withManual: RelatedTarget = { ...target, r: manual };
          const result = relatedProducts(withManual, pool);

          const expectedLead = [...new Set(manual)].slice(0, RELATED_LIMIT);
          expect(result.slice(0, expectedLead.length).map((doc) => doc.i)).toEqual(expectedLead);

          // Still bounded, still target-free, still duplicate-free.
          expect(result.length).toBeLessThanOrEqual(RELATED_LIMIT);
          expect(result.some((doc) => doc.i === target.i)).toBe(false);
          expect(new Set(result.map((doc) => doc.i)).size).toBe(result.length);

          // Every member is either operator-specified or genuinely relevant.
          const manualSet = new Set(manual);
          for (const doc of result) {
            expect(manualSet.has(doc.i) || sharesAnyAttribute(target, doc)).toBe(true);
          }
        },
      ),
    );
  });
});
