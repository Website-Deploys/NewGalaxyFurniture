/**
 * The sort engine: six options, every one a deterministic total order.
 *
 * The single most important property here is that **no comparator can return 0 for two
 * different products**. Every comparator ends with an ascending-slug tie-break, so a result
 * set renders in the same order on every device, on every reload, and after every re-filter
 * (Requirement 3.12, Properties 32–34). Without that, a catalogue with three ₹25,000 chairs
 * reshuffles between renders and looks broken.
 *
 * The second is honesty about basis (Requirements 3.13–3.16). Two of the six sorts cannot be
 * measured with the data this system has:
 *
 * - **Best Selling** is *always* curated. There are no transactions to count, so there is
 *   nothing to measure — not "no data yet", but "never". It is labelled curated permanently
 *   and carries no date.
 * - **Most Viewed** and **Trending** prefer the analytics snapshot and fall back to the
 *   operator's manual ordering. When they fall back they are labelled curated and carry no
 *   measurement date, and the visitor's chosen sort is retained rather than silently swapped
 *   (Requirement 3.15).
 *
 * `resolveRanking` returns the basis alongside the comparator input so the UI cannot label a
 * curated ordering as measured: the label is derived from the same value the ordering is.
 *
 * Design: Catalogue → Sorting, with honest fallbacks.
 * Requirements: 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16.
 */

import { hasFlag } from './types';
import type { ProductFlag, SearchDoc } from './types';

export type SortKey =
  'newest' | 'priceAsc' | 'priceDesc' | 'mostViewed' | 'bestSelling' | 'trending';

export const SORT_KEYS: readonly SortKey[] = [
  'newest',
  'priceAsc',
  'priceDesc',
  'mostViewed',
  'bestSelling',
  'trending',
];

/** Exactly the six options Requirement 3.10 names, in that order. */
export const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  newest: 'Newest',
  priceAsc: 'Price Low to High',
  priceDesc: 'Price High to Low',
  mostViewed: 'Most Viewed',
  bestSelling: 'Best Selling',
  trending: 'Trending',
};

export type RankingBasis = 'measured' | 'manual' | 'unavailable';

export interface RankingSource {
  key: SortKey;
  basis: RankingBasis;
  /** ISO date of the analytics snapshot. Present only when `basis === 'measured'`. */
  asOf?: string;
}

/** The operator's manual orderings, from `data/site/rankings.json`. */
export interface ManualRankings {
  trending: readonly string[];
  bestSeller: readonly string[];
  mostViewed: readonly string[];
}

/**
 * The measured input, from `data/snapshots/analytics.json`.
 *
 * `views` is a lifetime count per slug; `velocity` is the 7-day view velocity used by
 * Trending. Both are optional, because a snapshot can exist with only one of them.
 */
export interface AnalyticsSnapshot {
  asOf: string;
  views?: Readonly<Record<string, number>>;
  velocity?: Readonly<Record<string, number>>;
}

export interface RankingContext {
  manual: ManualRankings;
  snapshot: AnalyticsSnapshot | null;
}

export const EMPTY_MANUAL_RANKINGS: ManualRankings = Object.freeze({
  trending: Object.freeze([]),
  bestSeller: Object.freeze([]),
  mostViewed: Object.freeze([]),
});

export const EMPTY_RANKING_CONTEXT: RankingContext = Object.freeze({
  manual: EMPTY_MANUAL_RANKINGS,
  snapshot: null,
});

/* -------------------------------------------------------------------------- */
/* Basis resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether a snapshot carries usable numbers for any of the documents on screen.
 *
 * "The snapshot exists" is not enough: a snapshot with no row for any visible product would
 * order the results identically to no snapshot at all while claiming to be measured, which is
 * exactly the dressed-up-zeros failure the design refuses.
 */
function snapshotCovers(
  docs: readonly SearchDoc[],
  table: Readonly<Record<string, number>> | undefined,
): boolean {
  if (table === undefined) return false;
  return docs.some((doc) => typeof table[doc.i] === 'number');
}

export function resolveRanking(
  key: SortKey,
  docs: readonly SearchDoc[],
  context: RankingContext = EMPTY_RANKING_CONTEXT,
): RankingSource {
  switch (key) {
    // Derived from stored content, not from measurement, but not curated either — the
    // creation date is a fact about the record. Requirement 3.13 only constrains curated
    // rankings, and `newest`/price sorts are neither curated nor measured metrics, so they
    // are reported as measured with no snapshot date.
    case 'newest':
    case 'priceAsc':
    case 'priceDesc':
      return { key, basis: 'measured' };

    case 'bestSelling':
      // Never measurable. Requirement 3.16.
      return { key, basis: 'manual' };

    case 'mostViewed': {
      const snapshot = context.snapshot;
      if (snapshot !== null && snapshotCovers(docs, snapshot.views)) {
        return { key, basis: 'measured', asOf: snapshot.asOf };
      }
      return { key, basis: 'manual' };
    }

    case 'trending': {
      const snapshot = context.snapshot;
      if (snapshot !== null && snapshotCovers(docs, snapshot.velocity)) {
        return { key, basis: 'measured', asOf: snapshot.asOf };
      }
      return { key, basis: 'manual' };
    }
  }
}

/** The sort control's label: curated options say so, measured ones carry their date. */
export function sortOptionLabel(source: RankingSource): string {
  const base = SORT_LABELS[source.key];
  if (source.basis === 'manual') return `${base} (curated)`;
  return base;
}

/* -------------------------------------------------------------------------- */
/* Comparators                                                                */
/* -------------------------------------------------------------------------- */

/** The universal tie-break: ascending slug. Total, because slugs are unique per product. */
export function bySlug(a: SearchDoc, b: SearchDoc): number {
  return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
}

function numeric(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank within a manual ordering, with the flag as the secondary group.
 *
 * Three tiers: products the operator explicitly ordered (in their order), then products
 * carrying the corresponding flag, then everything else. Within a tier, slug order. This is
 * what makes a curated sort useful with a partially filled `rankings.json` — the operator
 * orders the ten they care about and the flagged remainder follows.
 */
function manualRank(doc: SearchDoc, order: readonly string[], flag: ProductFlag | null): number {
  const index = order.indexOf(doc.i);
  if (index >= 0) return index;
  if (flag === null) return order.length;
  return order.length + (hasFlag(doc, flag) ? 0 : 1);
}

/**
 * Price, with price-on-enquiry tailed in **both** directions (Requirement 3.11).
 *
 * Tailing rather than treating a missing price as 0 or infinity: a product with no price is
 * not cheap and is not expensive, and putting it at either extreme states something false
 * about it. A labelled tail is the honest position in both directions.
 */
function comparePrice(a: SearchDoc, b: SearchDoc, direction: 1 | -1): number {
  const aOnEnquiry = a.p === null;
  const bOnEnquiry = b.p === null;
  if (aOnEnquiry !== bOnEnquiry) return aOnEnquiry ? 1 : -1;
  if (aOnEnquiry && bOnEnquiry) return bySlug(a, b);
  return direction * numeric(a.p ?? 0, b.p ?? 0) || bySlug(a, b);
}

/**
 * The comparator for a sort key. Antisymmetric, transitive, and total (Property 34).
 *
 * Every branch ends in `bySlug`, and `bySlug` returns 0 only for equal slugs — so two
 * documents compare equal only when they are the same product.
 */
export function comparatorFor(
  key: SortKey,
  context: RankingContext = EMPTY_RANKING_CONTEXT,
): (a: SearchDoc, b: SearchDoc) => number {
  switch (key) {
    case 'newest':
      // Descending creation time.
      return (a, b) => numeric(b.ts, a.ts) || bySlug(a, b);

    case 'priceAsc':
      return (a, b) => comparePrice(a, b, 1);

    case 'priceDesc':
      return (a, b) => comparePrice(a, b, -1);

    case 'mostViewed': {
      const views = context.snapshot?.views;
      if (views !== undefined) {
        return (a, b) => numeric(views[b.i] ?? 0, views[a.i] ?? 0) || bySlug(a, b);
      }
      // No flag tier: there is no "most viewed" flag on a product, and borrowing one (say
      // `featured`) would silently turn an editorial choice into a claim about traffic.
      const order = context.manual.mostViewed;
      return (a, b) =>
        numeric(manualRank(a, order, null), manualRank(b, order, null)) || bySlug(a, b);
    }

    case 'bestSelling': {
      const order = context.manual.bestSeller;
      return (a, b) =>
        numeric(manualRank(a, order, 'bestSeller'), manualRank(b, order, 'bestSeller')) ||
        bySlug(a, b);
    }

    case 'trending': {
      const velocity = context.snapshot?.velocity;
      if (velocity !== undefined) {
        return (a, b) => numeric(velocity[b.i] ?? 0, velocity[a.i] ?? 0) || bySlug(a, b);
      }
      const order = context.manual.trending;
      return (a, b) =>
        numeric(manualRank(a, order, 'trending'), manualRank(b, order, 'trending')) || bySlug(a, b);
    }
  }
}

/**
 * Sort a document set. Returns a new array; the input is never mutated.
 *
 * A permutation of its input (Property 32) and idempotent (Property 33), both of which follow
 * from the comparator being a total order.
 */
export function sortDocs(
  docs: readonly SearchDoc[],
  key: SortKey,
  context: RankingContext = EMPTY_RANKING_CONTEXT,
): SearchDoc[] {
  return [...docs].sort(comparatorFor(key, context));
}
