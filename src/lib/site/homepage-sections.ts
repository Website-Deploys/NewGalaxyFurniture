/**
 * The homepage's product-section compositions, declared as data.
 *
 * Requirement 7.2 is unusually testable for a visual rule, and this module is what makes it so:
 *
 * > the featured, new arrivals, best sellers, and trending sections each with a composition that
 * > differs from the other three in at least one observable structural attribute — items per row at
 * > a viewport width of 1280 px, item aspect ratio, or scroll axis — such that no two of the four
 * > present the same combination of those three attributes, and SHALL NOT render the four as one
 * > repeated uniform card grid.
 *
 * "No two share the same combination" is a claim about three numbers per section. Written as prose
 * in four stylesheets it is unverifiable and drifts on the first tidy-up. Written here it is a
 * `Set` size check that runs at module load — so a future edit that makes new arrivals look like
 * featured fails the **build**, not a design review six weeks later.
 *
 * The values are not a description of the CSS; they are its source. Each section component reads
 * its own descriptor and emits the numbers as custom properties, so the stylesheet and the
 * assertion cannot disagree.
 *
 * Requirements: 7.2, 7.9.
 * Design: Pages, Navigation, and States → Homepage composition; Visual Design System → Layout
 * language.
 */

import type { HomepageSectionKeyValue } from '@/schemas/homepage';

/** The four sections Requirement 7.2 constrains. */
export const PRODUCT_SECTION_KEYS = [
  'featuredProducts',
  'newArrivals',
  'bestSellers',
  'trending',
] as const;

export type ProductSectionKey = (typeof PRODUCT_SECTION_KEYS)[number];

export interface ProductSectionComposition {
  key: ProductSectionKey;
  /** The named layout, for the component and for anyone reading the diff. */
  layout: 'editorial-pair' | 'scroll-rail' | 'asymmetric-2up' | 'numbered-list';
  /** Items per row at exactly 1280 px, the width Requirement 7.2 names. */
  itemsPerRowAt1280: number;
  /** The item aspect ratio, as a CSS `aspect-ratio` value. */
  aspectRatio: string;
  /** `block` — the items stack down the page. `inline` — they scroll sideways. */
  scrollAxis: 'block' | 'inline';
  /** How many products the section shows at most. */
  limit: number;
  /** The product flag that qualifies a product for this section. */
  flag: 'featured' | 'newArrival' | 'bestSeller' | 'trending';
}

/**
 * The four compositions.
 *
 * Chosen so that each differs from the other three on more than the minimum — a design that only
 * just satisfies 7.2 would satisfy it by accident, and the requirement's real intent (the second
 * clause: "SHALL NOT render the four as one repeated uniform card grid") needs them to read as four
 * different editorial ideas.
 */
export const PRODUCT_SECTION_COMPOSITIONS: readonly ProductSectionComposition[] = [
  {
    key: 'featuredProducts',
    layout: 'editorial-pair',
    itemsPerRowAt1280: 2,
    aspectRatio: '4 / 5',
    scrollAxis: 'block',
    limit: 4,
    flag: 'featured',
  },
  {
    key: 'newArrivals',
    layout: 'scroll-rail',
    itemsPerRowAt1280: 4,
    aspectRatio: '3 / 4',
    scrollAxis: 'inline',
    limit: 10,
    flag: 'newArrival',
  },
  {
    key: 'bestSellers',
    layout: 'asymmetric-2up',
    itemsPerRowAt1280: 3,
    aspectRatio: '16 / 10',
    scrollAxis: 'block',
    limit: 6,
    flag: 'bestSeller',
  },
  {
    key: 'trending',
    layout: 'numbered-list',
    itemsPerRowAt1280: 1,
    aspectRatio: '1 / 1',
    scrollAxis: 'block',
    limit: 5,
    flag: 'trending',
  },
];

export function compositionFor(key: ProductSectionKey): ProductSectionComposition {
  const found = PRODUCT_SECTION_COMPOSITIONS.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`HOMEPAGE_COMPOSITION_MISSING: no composition declared for "${key}"`);
  }
  return found;
}

/** The observable triple Requirement 7.2 compares on. */
export function compositionSignature(composition: ProductSectionComposition): string {
  return [
    composition.itemsPerRowAt1280,
    composition.aspectRatio.replace(/\s+/g, ''),
    composition.scrollAxis,
  ].join('|');
}

export function isProductSectionKey(key: HomepageSectionKeyValue): key is ProductSectionKey {
  return (PRODUCT_SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * Load-time structural check, in the same spirit as `assertNavigation`.
 *
 * A test would catch this too, but a build failure catches it *before* a preview deployment shows
 * four identical grids to a reviewer, and it catches it for anyone who edits the numbers without
 * running the suite.
 */
function assertDistinctCompositions(): void {
  if (PRODUCT_SECTION_COMPOSITIONS.length !== PRODUCT_SECTION_KEYS.length) {
    throw new Error(
      `HOMEPAGE_COMPOSITION_INVALID: ${PRODUCT_SECTION_COMPOSITIONS.length} compositions declared for ${PRODUCT_SECTION_KEYS.length} sections`,
    );
  }

  const signatures = PRODUCT_SECTION_COMPOSITIONS.map(compositionSignature);
  if (new Set(signatures).size !== signatures.length) {
    throw new Error(
      'HOMEPAGE_COMPOSITION_INVALID: two product sections share the same combination of ' +
        'items-per-row at 1280 px, aspect ratio, and scroll axis (requirement 7.2)',
    );
  }

  const layouts = PRODUCT_SECTION_COMPOSITIONS.map((entry) => entry.layout);
  if (new Set(layouts).size !== layouts.length) {
    throw new Error('HOMEPAGE_COMPOSITION_INVALID: two product sections share the same layout');
  }
}

assertDistinctCompositions();
