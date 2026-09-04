/**
 * The filter engine: seven dimensions, OR within each, AND across them.
 *
 * Everything here is pure and total, which is what lets Properties 31, 36, and 37 hold as
 * stated. Three decisions are worth naming:
 *
 * 1. **`filter` preserves input order and never invents a document.** It is `Array.filter`
 *    over a predicate, so it is by construction a subsequence of its input (Property 31).
 *    Ordering is the sort engine's job; mixing the two here is what makes filter/sort code
 *    unpredictable in most catalogues.
 * 2. **An unconstrained dimension imposes nothing** (Requirement 3.4). An empty array and
 *    `'any'` are both "no constraint", never "match nothing" — which is the bug that makes a
 *    freshly loaded catalogue render empty.
 * 3. **`q` is not applied here.** Text relevance is ranked, not boolean, and it comes from
 *    MiniSearch in `query.ts`. The catalogue pipeline is
 *    `candidatesFor(q) → filter(state) → sort(key)`, so `filter` stays a pure set operation
 *    and the neutral state really is the identity (Property 36). `q` travels inside
 *    `FilterState` only because it is part of the shareable URL state.
 *
 * Facet values and counts are derived from the documents at runtime, never hard-coded, so a
 * material or colour appears in the UI the moment one product uses it (Requirement 3.7).
 *
 * Design: Catalogue → Filters.
 * Requirements: 1.3, 3.1, 3.2, 3.3, 3.4, 3.7, 3.8, 3.9.
 */

import { priceBandOf, PRICE_BANDS } from '@/lib/money';
import type { PriceBandFilter } from '@/lib/money';
import type { SortKey } from './sort';
import type { SearchDoc } from './types';

/** The three required availability options (Requirement 3.3). */
export type AvailabilityFilter = 'any' | 'inStock' | 'madeToOrder';

export const AVAILABILITY_OPTIONS: readonly { value: AvailabilityFilter; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'inStock', label: 'In Stock' },
  { value: 'madeToOrder', label: 'Made to Order' },
];

/** The multi-select dimensions, which is also the set of dimensions the URL repeats. */
export const MULTI_DIMENSIONS = ['category', 'material', 'colour', 'size', 'style'] as const;
export type MultiDimension = (typeof MULTI_DIMENSIONS)[number];

/** All seven dimensions, in the order Requirement 3.1 lists them. */
export const DIMENSIONS = [
  'category',
  'priceBand',
  'availability',
  'material',
  'colour',
  'size',
  'style',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface FilterState {
  category: string[];
  priceBand: PriceBandFilter;
  availability: AvailabilityFilter;
  material: string[];
  colour: string[];
  size: string[];
  style: string[];
  sort: SortKey;
  q: string;
}

/**
 * The state a catalogue URL with no parameters produces: no filters, Newest sort
 * (Requirement 3.18). Frozen because it is shared, and a mutated "neutral" state would be an
 * extremely confusing bug.
 */
export const NEUTRAL_FILTER_STATE: Readonly<FilterState> = Object.freeze({
  category: [],
  priceBand: 'any' as const,
  availability: 'any' as const,
  material: [],
  colour: [],
  size: [],
  style: [],
  sort: 'newest' as const,
  q: '',
});

export function neutralState(): FilterState {
  return {
    category: [],
    priceBand: 'any',
    availability: 'any',
    material: [],
    colour: [],
    size: [],
    style: [],
    sort: 'newest',
    q: '',
  };
}

/** True when no filter dimension constrains anything — the sort is not a filter. */
export function isNeutral(state: FilterState): boolean {
  return (
    state.category.length === 0 &&
    state.material.length === 0 &&
    state.colour.length === 0 &&
    state.size.length === 0 &&
    state.style.length === 0 &&
    state.priceBand === 'any' &&
    state.availability === 'any'
  );
}

/**
 * Case- and diacritic-insensitive comparison key for facet values.
 *
 * Operator-entered attributes drift in case and spacing ("Sheesham wood", "Sheesham Wood"),
 * and two chips for one material with split counts is worse than one chip. The **displayed**
 * label is the first spelling encountered in catalogue order; matching is on the folded key.
 */
export function facetKey(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function anyMatch(selected: readonly string[], values: readonly string[]): boolean {
  if (selected.length === 0) return true; // unconstrained
  const wanted = new Set(selected.map(facetKey));
  return values.some((value) => wanted.has(facetKey(value)));
}

/**
 * "In Stock" includes `LIMITED_STOCK`.
 *
 * Requirement 3.3 names three visitor-facing options over four stored stock statuses, so two
 * of them must map onto one option. Limited stock *is* in stock — the product can be bought
 * today — and putting it under "Made to Order" would be false while omitting it from both
 * would make a purchasable product unreachable through the availability filter.
 */
function matchesAvailability(doc: SearchDoc, availability: AvailabilityFilter): boolean {
  switch (availability) {
    case 'any':
      return true;
    case 'inStock':
      return doc.st === 'IN_STOCK' || doc.st === 'LIMITED_STOCK';
    case 'madeToOrder':
      return doc.st === 'MADE_TO_ORDER';
  }
}

/** Price-on-enquiry documents have no band, so they match no band — only "Any" (3.9). */
function matchesPriceBand(doc: SearchDoc, band: PriceBandFilter): boolean {
  if (band === 'any') return true;
  return priceBandOf(doc.p) === band;
}

export function matches(doc: SearchDoc, state: FilterState): boolean {
  return (
    anyMatch(state.category, [doc.c]) &&
    matchesPriceBand(doc, state.priceBand) &&
    matchesAvailability(doc, state.availability) &&
    anyMatch(state.material, doc.m === undefined ? [] : [doc.m]) &&
    anyMatch(state.colour, doc.o) &&
    anyMatch(state.size, doc.sz === undefined ? [] : [doc.sz]) &&
    anyMatch(state.style, doc.t)
  );
}

/**
 * The filtered set, in input order.
 *
 * Order-preserving, duplication-free, and never larger than its input — Properties 31 and 36
 * hold because this is a single `Array.filter` and nothing downstream reorders it.
 */
export function filter(docs: readonly SearchDoc[], state: FilterState): SearchDoc[] {
  return docs.filter((doc) => matches(doc, state));
}

/* -------------------------------------------------------------------------- */
/* Facets                                                                     */
/* -------------------------------------------------------------------------- */

export interface FacetOption {
  /** The value as it goes into the URL and into `FilterState`. */
  value: string;
  /** The label as it is displayed — the first spelling seen in catalogue order. */
  label: string;
  /** Products returned if this option were selected alongside the other active dimensions. */
  count: number;
  /** True when `count === 0`: rendered disabled, never removed (Requirement 3.8). */
  disabled: boolean;
  /** Whether this option is currently part of the state. */
  selected: boolean;
}

export interface Facets {
  category: FacetOption[];
  priceBand: FacetOption[];
  availability: FacetOption[];
  material: FacetOption[];
  colour: FacetOption[];
  size: FacetOption[];
  style: FacetOption[];
}

/** The values a dimension takes across a document, for vocabulary building. */
function valuesOf(doc: SearchDoc, dimension: MultiDimension): string[] {
  switch (dimension) {
    case 'category':
      return [doc.c];
    case 'material':
      return doc.m === undefined ? [] : [doc.m];
    case 'colour':
      return doc.o;
    case 'size':
      return doc.sz === undefined ? [] : [doc.sz];
    case 'style':
      return doc.t;
  }
}

/**
 * Every value each multi-select dimension takes across the catalogue, in first-seen order.
 *
 * This is the runtime-derived vocabulary Requirement 3.7 asks for, and it is also what
 * `parseFilters` uses to drop URL values that name something absent from the catalogue
 * (Requirement 3.19).
 */
export function facetVocabulary(docs: readonly SearchDoc[]): Record<MultiDimension, string[]> {
  const out: Record<MultiDimension, string[]> = {
    category: [],
    material: [],
    colour: [],
    size: [],
    style: [],
  };
  for (const dimension of MULTI_DIMENSIONS) {
    const seen = new Map<string, string>();
    for (const doc of docs) {
      for (const value of valuesOf(doc, dimension)) {
        const key = facetKey(value);
        if (key !== '' && !seen.has(key)) seen.set(key, value);
      }
    }
    out[dimension] = [...seen.values()];
  }
  return out;
}

/** Category display names, so the category facet reads "Sofas & Sectionals" not "sofas". */
export type CategoryNames = Readonly<Record<string, string>>;

/**
 * Facet options with counts.
 *
 * The count for an option is the number of products that would be returned **if that option
 * were the selection in its own dimension** while every other dimension keeps its current
 * selection (Requirement 3.7). That is what makes the numbers usable: they answer "what
 * happens if I click this", not "how many products have this attribute in the whole
 * catalogue" — a number that is reassuring and wrong the moment any other filter is active.
 */
export function facetCounts(
  docs: readonly SearchDoc[],
  state: FilterState,
  categoryNames: CategoryNames = {},
): Facets {
  const vocabulary = facetVocabulary(docs);

  const countWith = (override: Partial<FilterState>): number =>
    filter(docs, { ...state, ...override }).length;

  const multi = (dimension: MultiDimension, label?: (value: string) => string): FacetOption[] => {
    const selectedKeys = new Set(state[dimension].map(facetKey));
    return vocabulary[dimension].map((value) => {
      const count = countWith({ [dimension]: [value] });
      return {
        value,
        label: label === undefined ? value : label(value),
        count,
        disabled: count === 0,
        selected: selectedKeys.has(facetKey(value)),
      };
    });
  };

  const priceBand: FacetOption[] = [
    {
      value: 'any',
      label: 'Any',
      count: countWith({ priceBand: 'any' }),
      disabled: false, // "Any" is the neutral option; it is never disabled.
      selected: state.priceBand === 'any',
    },
    ...PRICE_BANDS.map((band) => {
      const count = countWith({ priceBand: band.band });
      return {
        value: band.band,
        label: band.label,
        count,
        disabled: count === 0,
        selected: state.priceBand === band.band,
      };
    }),
  ];

  const availability: FacetOption[] = AVAILABILITY_OPTIONS.map((option) => {
    const count = countWith({ availability: option.value });
    return {
      value: option.value,
      label: option.label,
      count,
      disabled: option.value !== 'any' && count === 0,
      selected: state.availability === option.value,
    };
  });

  return {
    category: multi('category', (slug) => categoryNames[slug] ?? slug),
    priceBand,
    availability,
    material: multi('material'),
    colour: multi('colour'),
    size: multi('size'),
    style: multi('style'),
  };
}

/**
 * Clear every filter, retaining the sort and the query (Requirement 3.17).
 *
 * The "clear filters" control in the no-match state must not silently change the sort — the
 * visitor chose it, and re-applying Newest would look like the site ignoring them.
 */
export function clearFilters(state: FilterState): FilterState {
  return { ...neutralState(), sort: state.sort, q: state.q };
}

/** Toggle one value in a multi-select dimension, preserving selection order. */
export function toggleValue(
  state: FilterState,
  dimension: MultiDimension,
  value: string,
): FilterState {
  const key = facetKey(value);
  const current = state[dimension];
  const next = current.some((entry) => facetKey(entry) === key)
    ? current.filter((entry) => facetKey(entry) !== key)
    : [...current, value];
  return { ...state, [dimension]: next };
}
