/**
 * The catalogue filter — the single definition of "is this product public?".
 *
 * Kept in its own module, free of any `astro:content` import, for two reasons: it
 * is the one predicate every public surface must agree on, and it must be unit
 * testable outside the Astro runtime (`tests/unit/catalogue-filter.test.ts`).
 * `src/lib/content/catalogue.ts` re-exports these and wires them to the collection.
 *
 * `PUBLISHED` and `OUT_OF_STOCK` are public; `DRAFT`, `REVIEW`, and `UNPUBLISHED`
 * are not. An out-of-stock product keeps its live, indexable page with degraded
 * CTAs — see the design's note on OUT_OF_STOCK as a lifecycle status.
 *
 * Design: Data Models → Canonical product schema; Catalogue.
 * Requirements: 1.1, 1.16, 2.11, 4.1, 4.12, 14.9, 18.8, 26.1.
 */

import { PUBLIC_STATUSES } from '@/schemas/product';
import type { ProductStatusValue } from '@/schemas/product';

/** The minimum a value must carry to be classified — so drafts in KV can be tested too. */
export interface CatalogueCandidate {
  readonly status: ProductStatusValue;
}

/** True when the product belongs in the public catalogue. */
export function isCatalogueProduct(product: CatalogueCandidate): boolean {
  return PUBLIC_STATUSES.includes(product.status);
}

/** Order-preserving filter to the public catalogue. */
export function filterCatalogue<T extends CatalogueCandidate>(products: readonly T[]): T[] {
  return products.filter((product) => isCatalogueProduct(product));
}

export interface CategoryCandidate {
  readonly published: boolean;
  readonly order: number;
  readonly slug: string;
}

/** True when the category should appear in navigation, filters, and routes. */
export function isPublishedCategory(category: CategoryCandidate): boolean {
  return category.published;
}

/**
 * Published categories in operator order. Ties break on slug so repeated renders
 * cannot reshuffle navigation.
 */
export function filterCategories<T extends CategoryCandidate>(categories: readonly T[]): T[] {
  return categories
    .filter((category) => isPublishedCategory(category))
    .sort((a, b) => (a.order === b.order ? a.slug.localeCompare(b.slug) : a.order - b.order));
}
