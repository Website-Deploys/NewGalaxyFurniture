/**
 * The admin product list query: filter by status and category, search by text, paginate.
 *
 * Pure and separate from the endpoint so the exact behaviour the operator sees is unit
 * testable without a request: which rows match, in what order, and what the totals are.
 *
 * Search is a substring match over the fields an operator actually searches by — name,
 * SKU, slug, category, subcategory. It is deliberately *not* the public catalogue's
 * ranked search: the operator knows what they are looking for and needs "find the row",
 * not "rank the catalogue". Matching is case- and diacritic-insensitive so "Café" finds
 * "cafe".
 *
 * Requirements: 12.2.
 */

import type { ProductStatusValue } from '@/schemas/product';
import type { ProductSummary } from './index-store';

export const PRODUCT_PAGE_SIZE = 25;

export interface ProductQuery {
  status?: ProductStatusValue | 'ALL';
  category?: string;
  q?: string;
  page?: number;
}

export interface ProductPage {
  items: ProductSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Lowercase, diacritic-free, whitespace-collapsed — for both haystack and needle. */
export function foldForSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function haystack(summary: ProductSummary): string {
  return foldForSearch(
    [summary.name, summary.sku, summary.slug, summary.category, summary.subcategory ?? ''].join(
      ' ',
    ),
  );
}

/**
 * Newest edit first.
 *
 * The tie-break on slug is not decoration: two products saved in the same millisecond
 * would otherwise order differently between two reads of the same data, which makes
 * pagination lose or repeat rows.
 */
export function byRecentlyUpdated(a: ProductSummary, b: ProductSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

export function filterProducts(
  summaries: readonly ProductSummary[],
  query: ProductQuery,
): ProductSummary[] {
  const needle = query.q === undefined ? '' : foldForSearch(query.q);
  return summaries.filter((summary) => {
    if (query.status !== undefined && query.status !== 'ALL' && summary.status !== query.status) {
      return false;
    }
    if (
      query.category !== undefined &&
      query.category !== '' &&
      summary.category !== query.category
    )
      return false;
    if (needle !== '' && !haystack(summary).includes(needle)) return false;
    return true;
  });
}

/** Filter, sort, paginate. A page beyond the end returns no rows and an honest total. */
export function pageOfProducts(
  summaries: readonly ProductSummary[],
  query: ProductQuery = {},
): ProductPage {
  const matched = filterProducts(summaries, query).sort(byRecentlyUpdated);
  const pageSize = PRODUCT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(matched.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(query.page ?? 1)), pageCount);
  const start = (page - 1) * pageSize;
  return {
    items: matched.slice(start, start + pageSize),
    total: matched.length,
    page,
    pageSize,
    pageCount,
  };
}

/** Parse the query string into a `ProductQuery`, ignoring anything unrecognised. */
export function parseProductQuery(params: URLSearchParams): ProductQuery {
  const status = params.get('status');
  const category = params.get('category');
  const q = params.get('q');
  const page = Number.parseInt(params.get('page') ?? '', 10);
  const known: readonly string[] = [
    'DRAFT',
    'REVIEW',
    'PUBLISHED',
    'UNPUBLISHED',
    'OUT_OF_STOCK',
    'ALL',
  ];
  return {
    ...(status !== null && known.includes(status)
      ? { status: status as ProductStatusValue | 'ALL' }
      : {}),
    ...(category !== null && category !== '' ? { category } : {}),
    ...(q !== null && q.trim() !== '' ? { q } : {}),
    ...(Number.isFinite(page) && page > 0 ? { page } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Dashboard counts                                                           */
/* -------------------------------------------------------------------------- */

export interface CatalogueCounts {
  published: number;
  draft: number;
  review: number;
  unpublished: number;
  outOfStock: number;
  total: number;
}

/**
 * Counts for the dashboard, each one a tally of stored records.
 *
 * Nothing here estimates, extrapolates, or samples: every number is the length of a
 * filtered list of index rows, and each index row is a copy of a committed product
 * (Requirement 11.3). `total === 0` is what the dashboard renders as an empty state rather
 * than as five zeros (Requirement 11.4).
 */
export function catalogueCounts(summaries: readonly ProductSummary[]): CatalogueCounts {
  const count = (status: ProductStatusValue): number =>
    summaries.filter((summary) => summary.status === status).length;
  return {
    published: count('PUBLISHED'),
    draft: count('DRAFT'),
    review: count('REVIEW'),
    unpublished: count('UNPUBLISHED'),
    outOfStock: count('OUT_OF_STOCK'),
    total: summaries.length,
  };
}
