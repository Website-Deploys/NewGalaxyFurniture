import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  generateSku,
  SKU_PATTERN,
  SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  toSlug,
  uniqueSlug,
} from '@/lib/slug';

import { categorySlugArb, productNameArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * Slug and SKU generation.
 *
 * Design: Data Models → Slug and SKU generation.
 */

/** Hostile names: diacritics, CJK, emoji, punctuation runs, whitespace-only, very long. */
const anyNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: productNameArb },
  { weight: 3, arbitrary: fc.string({ maxLength: 200 }) },
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', maxLength: 200 }) },
  { weight: 1, arbitrary: fc.string({ minLength: 0, maxLength: 500 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '',
      '   ',
      '\t\n',
      '---',
      '!!!???',
      'Café Chaise Longue',
      'ＦＵＬＬＷＩＤＴＨ Sofa',
      'सोफा सेट',
      '沙发',
      '🛋️🪑',
      'a'.repeat(500),
      `${'word-'.repeat(30)}end`,
      'ß ø đ ł',
    ),
  },
);

describe('Property 1: Slug output charset is closed', () => {
  it('always matches the slug pattern or equals the fallback', () => {
    assertProperty(
      fc.property(anyNameArb, (name) => {
        const slug = toSlug(name);
        expect(SLUG_PATTERN.test(slug) || slug === SLUG_FALLBACK).toBe(true);
      }),
    );
  });
});

describe('Property 2: Slug generation is idempotent', () => {
  it('double application equals single application', () => {
    assertProperty(
      fc.property(anyNameArb, (name) => {
        const once = toSlug(name);
        expect(toSlug(once)).toBe(once);
      }),
    );
  });
});

describe('Property 3: Slug length is bounded', () => {
  it('never exceeds 80 characters', () => {
    assertProperty(
      fc.property(anyNameArb, (name) => {
        expect(toSlug(name).length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
      }),
    );
  });

  it('is never empty', () => {
    assertProperty(
      fc.property(anyNameArb, (name) => {
        expect(toSlug(name).length).toBeGreaterThan(0);
      }),
    );
  });
});

describe('Property 4: Unique slug avoids collisions and preserves its prefix', () => {
  /** Sets that actually collide: the base slug plus its -2…-9 suffixes. */
  const takenArb = (name: string): fc.Arbitrary<Set<string>> => {
    const base = toSlug(name);
    return fc
      .tuple(
        fc.subarray([base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]),
        fc.uniqueArray(fc.string({ maxLength: 20 }).map(toSlug), { maxLength: 10 }),
      )
      .map(([colliding, unrelated]) => new Set([...colliding, ...unrelated]));
  };

  it('returns a slug outside the taken set that starts with the base slug', () => {
    assertProperty(
      fc.property(
        anyNameArb.chain((name) => takenArb(name).map((taken) => [name, taken] as const)),
        ([name, taken]) => {
          const slug = uniqueSlug(name, taken);
          expect(taken.has(slug)).toBe(false);
          expect(slug.startsWith(toSlug(name))).toBe(true);
        },
      ),
    );
  });

  it('returns the base slug untouched when nothing collides', () => {
    assertProperty(
      fc.property(anyNameArb, (name) => {
        expect(uniqueSlug(name, new Set())).toBe(toSlug(name));
      }),
    );
  });

  it('never rewrites a slug that is already taken by the product itself', () => {
    // Slug stability: asking twice with the same inputs yields the same answer.
    assertProperty(
      fc.property(
        anyNameArb,
        fc.uniqueArray(fc.string({ maxLength: 20 }).map(toSlug), { maxLength: 10 }),
        (name, existing) => {
          const taken = new Set(existing);
          expect(uniqueSlug(name, taken)).toBe(uniqueSlug(name, taken));
        },
      ),
    );
  });
});

describe('Property 5: Folding unique slug over a growing set yields distinct slugs', () => {
  it('produces all-distinct slugs even when every name is the same', () => {
    assertProperty(
      fc.property(
        fc.array(fc.oneof(fc.constant('Luxury L-Shape Sofa'), fc.constant('   '), anyNameArb), {
          maxLength: 50,
        }),
        (names) => {
          const taken = new Set<string>();
          const slugs = names.map((name) => {
            const slug = uniqueSlug(name, taken);
            taken.add(slug);
            return slug;
          });
          expect(new Set(slugs).size).toBe(slugs.length);
        },
      ),
    );
  });
});

describe('Property 6: SKU generation is unique and well-formed', () => {
  it('matches the SKU pattern and avoids the taken set', () => {
    assertProperty(
      fc.property(
        categorySlugArb,
        fc.uniqueArray(fc.string({ maxLength: 20 }), { maxLength: 20 }),
        (category, taken) => {
          const sku = generateSku(category, new Set(taken));
          expect(SKU_PATTERN.test(sku)).toBe(true);
          expect(taken).not.toContain(sku);
        },
      ),
    );
  });

  it('carries the category prefix and stays inside the length bound', () => {
    assertProperty(
      fc.property(categorySlugArb, (category) => {
        const sku = generateSku(category, new Set());
        expect(sku.startsWith('NGF-')).toBe(true);
        expect(sku.length).toBeLessThanOrEqual(32);
      }),
    );
  });

  it('escapes a taken set that already holds thousands of its own SKUs', () => {
    assertProperty(
      fc.property(categorySlugArb, (category) => {
        const taken = new Set<string>();
        for (let i = 0; i < 500; i += 1) taken.add(generateSku(category, taken));
        const sku = generateSku(category, taken);
        expect(taken.has(sku)).toBe(false);
        expect(SKU_PATTERN.test(sku)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it('generates a well-formed SKU for a category with no declared prefix', () => {
    assertProperty(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }).map(toSlug), (category) => {
        expect(SKU_PATTERN.test(generateSku(category, new Set()))).toBe(true);
      }),
    );
  });
});
