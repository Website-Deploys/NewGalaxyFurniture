import { describe, expect, it } from 'vitest';

import { productsForSection, type RankingLists } from '@/lib/products/homepage-picks';
import {
  compositionFor,
  compositionSignature,
  isProductSectionKey,
  PRODUCT_SECTION_COMPOSITIONS,
  PRODUCT_SECTION_KEYS,
} from '@/lib/site/homepage-sections';
import {
  getEnabledSections,
  getHomepage,
  getPlaceholderKeys,
  getSiteSettings,
} from '@/lib/content/site';
import { HOMEPAGE_SECTION_KEYS, HomepageSchema } from '@/schemas/homepage';
import type { Product } from '@/schemas/product';

/**
 * The homepage's contracts, as values.
 *
 * Requirement 7.1 (fifteen sections in one order, order preserved under omission), 7.2 (four
 * structurally distinct product-section compositions), 7.9 (a section with no products omits itself
 * and substitutes nothing), and 7.10 / 8.8 (unsupplied copy is on the checklist) are all statements
 * about data. Asserting them here is both cheaper and stricter than asserting them against rendered
 * pixels — and 7.2 in particular is unfalsifiable in prose.
 *
 * Requirements: 7.1, 7.2, 7.9, 7.10, 7.13, 8.8.
 */

/* -------------------------------------------------------------------------- */
/* Section order (Requirements 7.1, 7.13)                                     */
/* -------------------------------------------------------------------------- */

describe('the fifteen sections and their order (Requirement 7.1)', () => {
  it('declares exactly the fifteen named sections, in the required order', () => {
    expect(HOMEPAGE_SECTION_KEYS).toEqual([
      'hero',
      'shopByCategory',
      'featuredProducts',
      'newArrivals',
      'bestSellers',
      'trending',
      'craftsmanship',
      'directManufacturer',
      'customFurniture',
      'workshopStory',
      'customerReviews',
      'gallery',
      'whatsappCta',
      'contactLocation',
      'footer',
    ]);
    expect(HOMEPAGE_SECTION_KEYS).toHaveLength(15);
  });

  it('ships all fifteen enabled, in that order', () => {
    expect(getHomepage().sections.map((section) => section.key)).toEqual(HOMEPAGE_SECTION_KEYS);
    expect(getEnabledSections().map((section) => section.key)).toEqual(HOMEPAGE_SECTION_KEYS);
  });

  it('preserves the relative order of the remaining sections when any are omitted', () => {
    // Requirement 7.1's second clause. Every single-omission case, plus a few multiples.
    const all = getHomepage();
    for (const omitted of HOMEPAGE_SECTION_KEYS) {
      const parsed = HomepageSchema.parse({
        sections: all.sections.map((section) =>
          section.key === omitted ? { ...section, enabled: false } : section,
        ),
      });
      const rendered = parsed.sections
        .filter((section) => section.enabled)
        .map((section) => section.key);
      expect(rendered).toEqual(HOMEPAGE_SECTION_KEYS.filter((key) => key !== omitted));
    }
  });

  it('rejects a content file that reorders the sections, so 7.1 cannot be violated by data', () => {
    const all = getHomepage();
    const swapped = [...all.sections];
    const [first, second] = [swapped[2], swapped[4]];
    if (first === undefined || second === undefined) throw new Error('fixture');
    swapped[2] = second;
    swapped[4] = first;
    expect(HomepageSchema.safeParse({ sections: swapped }).success).toBe(false);
  });

  it('rejects a duplicated section', () => {
    const all = getHomepage();
    const hero = all.sections[0];
    if (hero === undefined) throw new Error('fixture');
    expect(HomepageSchema.safeParse({ sections: [hero, hero] }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Distinct compositions (Requirement 7.2)                                    */
/* -------------------------------------------------------------------------- */

describe('the four product sections are structurally distinct (Requirement 7.2)', () => {
  it('declares a composition for each of the four, and only those four', () => {
    expect(PRODUCT_SECTION_COMPOSITIONS.map((entry) => entry.key)).toEqual([
      ...PRODUCT_SECTION_KEYS,
    ]);
    for (const key of PRODUCT_SECTION_KEYS) expect(isProductSectionKey(key)).toBe(true);
    expect(isProductSectionKey('hero')).toBe(false);
    expect(isProductSectionKey('gallery')).toBe(false);
  });

  it('no two share the same combination of items-per-row at 1280 px, aspect ratio, and scroll axis', () => {
    const signatures = PRODUCT_SECTION_COMPOSITIONS.map(compositionSignature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('differs pairwise on at least one of the three observable attributes', () => {
    // Stronger and more legible than the set check: it names which pair would break.
    for (const a of PRODUCT_SECTION_COMPOSITIONS) {
      for (const b of PRODUCT_SECTION_COMPOSITIONS) {
        if (a.key === b.key) continue;
        const differs =
          a.itemsPerRowAt1280 !== b.itemsPerRowAt1280 ||
          a.aspectRatio !== b.aspectRatio ||
          a.scrollAxis !== b.scrollAxis;
        expect(differs, `${a.key} and ${b.key} are structurally identical`).toBe(true);
      }
    }
  });

  it('is not one repeated uniform card grid: the four differ in layout, and one scrolls sideways', () => {
    const layouts = PRODUCT_SECTION_COMPOSITIONS.map((entry) => entry.layout);
    expect(new Set(layouts).size).toBe(4);
    expect(
      PRODUCT_SECTION_COMPOSITIONS.filter((entry) => entry.scrollAxis === 'inline'),
    ).toHaveLength(1);
    // A grid where every section shows the same number per row would be the failure mode.
    expect(
      new Set(PRODUCT_SECTION_COMPOSITIONS.map((e) => e.itemsPerRowAt1280)).size,
    ).toBeGreaterThan(1);
    expect(new Set(PRODUCT_SECTION_COMPOSITIONS.map((e) => e.aspectRatio)).size).toBe(4);
  });

  it('raises a named error for a key with no composition', () => {
    // @ts-expect-error — deliberately outside the union, to exercise the guard.
    expect(() => compositionFor('nope')).toThrow(/HOMEPAGE_COMPOSITION_MISSING/);
  });
});

/* -------------------------------------------------------------------------- */
/* Section membership (Requirement 7.9)                                       */
/* -------------------------------------------------------------------------- */

const NO_RANKINGS: RankingLists = { trending: [], bestSeller: [], mostViewed: [] };

function product(overrides: Partial<Product> & { slug: string }): Product {
  return {
    id: `p_${overrides.slug.replace(/\W/g, '').padEnd(10, 'x').slice(0, 10)}`,
    sku: `NGF-X-${overrides.slug.toUpperCase()}`,
    name: overrides.slug,
    category: 'sofas',
    tags: [],
    description: 'A product used in tests.',
    currency: 'INR',
    price: 1000,
    priceOnEnquiry: false,
    originalPrice: null,
    discount: null,
    stockStatus: 'IN_STOCK',
    madeToOrder: false,
    availableColors: [],
    variants: [],
    images: [],
    featured: false,
    trending: false,
    bestSeller: false,
    newArrival: false,
    relatedProductIds: [],
    status: 'PUBLISHED',
    published: true,
    keywords: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    aiAssisted: false,
    aiFields: [],
    ...overrides,
  };
}

describe('what each product section shows (Requirements 7.2, 7.9)', () => {
  it('returns nothing when no product carries the section\u2019s flag', () => {
    const products = [product({ slug: 'plain-one' }), product({ slug: 'plain-two' })];
    for (const key of PRODUCT_SECTION_KEYS) {
      expect(productsForSection(products, compositionFor(key), NO_RANKINGS)).toEqual([]);
    }
  });

  it('never substitutes a product from another section', () => {
    // The failure mode Requirement 7.9 names: a featured product must not appear under "Trending"
    // because trending resolved to nothing.
    const products = [product({ slug: 'only-featured', featured: true })];
    expect(
      productsForSection(products, compositionFor('featuredProducts'), NO_RANKINGS).map(
        (p) => p.slug,
      ),
    ).toEqual(['only-featured']);
    for (const key of ['newArrivals', 'bestSellers', 'trending'] as const) {
      expect(productsForSection(products, compositionFor(key), NO_RANKINGS)).toEqual([]);
    }
  });

  it('selects only products carrying the flag, and caps at the section\u2019s limit', () => {
    const composition = compositionFor('featuredProducts');
    const products = Array.from({ length: composition.limit + 3 }, (_unused, index) =>
      product({ slug: `featured-${index}`, featured: true }),
    );
    products.push(product({ slug: 'not-featured' }));
    const selected = productsForSection(products, composition, NO_RANKINGS);
    expect(selected).toHaveLength(composition.limit);
    expect(selected.every((entry) => entry.featured)).toBe(true);
  });

  it('honours the operator\u2019s curated order for best sellers and trending', () => {
    const products = [
      product({ slug: 'alpha', bestSeller: true, trending: true }),
      product({ slug: 'beta', bestSeller: true, trending: true }),
      product({ slug: 'gamma', bestSeller: true, trending: true }),
    ];
    const rankings: RankingLists = {
      bestSeller: ['gamma', 'alpha'],
      trending: ['beta'],
      mostViewed: [],
    };
    expect(
      productsForSection(products, compositionFor('bestSellers'), rankings).map((p) => p.slug),
    ).toEqual(['gamma', 'alpha', 'beta']);
    expect(
      productsForSection(products, compositionFor('trending'), rankings).map((p) => p.slug),
    ).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('orders unranked products newest first, then by slug, so the homepage is deterministic', () => {
    const products = [
      product({ slug: 'older', featured: true, createdAt: '2026-01-01T00:00:00.000Z' }),
      product({ slug: 'newer', featured: true, createdAt: '2026-06-01T00:00:00.000Z' }),
      product({ slug: 'a-same', featured: true, createdAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const first = productsForSection(products, compositionFor('featuredProducts'), NO_RANKINGS);
    const second = productsForSection(
      [...products].reverse(),
      compositionFor('featuredProducts'),
      NO_RANKINGS,
    );
    expect(first.map((p) => p.slug)).toEqual(['a-same', 'newer', 'older']);
    expect(second.map((p) => p.slug)).toEqual(first.map((p) => p.slug));
  });
});

/* -------------------------------------------------------------------------- */
/* Placeholder discipline (Requirements 7.10, 8.8)                            */
/* -------------------------------------------------------------------------- */

describe('placeholder discipline (Requirements 7.10, 8.4, 8.8)', () => {
  const settings = getSiteSettings();
  const homepage = getHomepage();

  /**
   * This used to assert the opposite: that the four editorial sections were `awaitingCopy: true`
   * and that each body still contained a `[PLACEHOLDER — …]` marker. That was an assertion about
   * the *content file's* state, and it was correct while the file held nothing but markers.
   *
   * The markers have been replaced with real, customer-facing copy, so the old assertion would now
   * be asserting that the homepage is unfinished. What Requirement 7.10 actually forbids is stating
   * a manufacturing process, timeline, capability, or business achievement the operator has not
   * supplied — and that is a property of the *words*, not of a boolean. So the test now checks the
   * words, on every section, which is strictly more than it checked before:
   *
   * - no developer-facing string reaches a visitor;
   * - no lead time, no price, no quantity, and no "since <year>" / "<n> years" claim.
   *
   * The checklist obligation is unchanged and is covered by the next test: `settings.placeholders`
   * still lists all five body keys, so the operator's list of copy they have not written in their
   * own words survives the page being made presentable.
   */
  it('states no unsupplied fact and leaks no developer string in any section copy', () => {
    /** Anything a visitor must never read. */
    const developerStrings = [/\[PLACEHOLDER/i, /awaiting content/i, /\bTODO\b/, /lorem ipsum/i];
    /** Claims Requirement 7.10 reserves to the operator: timelines, prices, achievements. */
    const unsupportedClaims = [
      /\b\d+\s*(?:-|\s)?\s*(?:day|days|week|weeks|month|months)\b/i,
      /\b(?:₹|rs\.?|inr)\s*\d/i,
      /\bsince\s+(?:19|20)\d{2}\b/i,
      /\b\d+\+?\s*years?\b/i,
      /\b\d[\d,]*\s*(?:pieces|customers|homes|orders|clients)\b/i,
    ];

    for (const section of homepage.sections) {
      const copy = [section.eyebrow, section.heading, section.subheading, section.body, section.tagline]
        .filter((value): value is string => value !== undefined)
        .join('\n');
      if (copy === '') continue;

      for (const pattern of developerStrings) {
        expect(pattern.test(copy), `${section.key} must not leak ${String(pattern)}`).toBe(false);
      }
      for (const pattern of unsupportedClaims) {
        expect(pattern.test(copy), `${section.key} must not claim ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('keeps the marker path working for any section still awaiting copy', () => {
    // The mechanism, not the content: a section that *is* awaiting copy must carry a body for the
    // schema to accept it, which is what keeps `PlaceholderCopy` reachable and the checklist honest.
    for (const section of homepage.sections) {
      if (!section.awaitingCopy) continue;
      expect(section.body, section.key).toBeDefined();
    }
  });

  it('lists every unsupplied homepage and page key in the admin content checklist', () => {
    const keys = getPlaceholderKeys();
    for (const key of [
      'homepage.craftsmanship.body',
      'homepage.directManufacturer.body',
      'homepage.workshopStory.body',
      'homepage.contactLocation.body',
      'page.about.body',
      'page.workshop.body',
      'page.faq.entries',
      'page.privacy.body',
      'page.terms.body',
      'page.shipping.body',
      'page.returns.body',
      'page.warranty.body',
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it('tracks the unsupplied hero image and logo, so the hero is a swap and not a redraw', () => {
    expect(settings.placeholders).toContain('site.logo.src');
    expect(settings.placeholders).toContain('site.heroImage');
    expect(settings.logo.src).toBeNull();
  });

  it('states no address, opening hours, or map link, because none is supplied', () => {
    expect(settings.location.addressLines).toEqual([]);
    expect(settings.location.city).toBe('');
    expect(settings.location.mapUrl).toBeNull();
    expect(settings.location.geo).toBeNull();
    for (const key of [
      'site.location.addressLines',
      'site.location.city',
      'site.location.mapUrl',
      'site.location.openingHours',
    ]) {
      expect(settings.placeholders, key).toContain(key);
    }
  });

  it('never claims a delivery, return, cancellation, or warranty term in homepage copy', () => {
    // Requirement 8.4 read as a property of the shipped content: no duration, window, or guarantee
    // appears anywhere in the section copy the operator has not written.
    const forbidden =
      /\b(\d+\s*(day|days|week|weeks|month|months|year|years)|free (delivery|shipping)|money[- ]back|lifetime|guarantee[d]?)\b/i;
    for (const section of homepage.sections) {
      for (const field of [
        section.eyebrow,
        section.heading,
        section.subheading,
        section.body,
        section.ctaLabel,
      ]) {
        if (field === undefined) continue;
        expect(field, `${section.key}: ${field}`).not.toMatch(forbidden);
      }
    }
  });
});
