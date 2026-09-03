/**
 * Search index generation.
 *
 * One product record in, one compact `SearchDoc` out, for every Catalogue product — and
 * nothing else. The Draft/UNPUBLISHED exclusion is not re-implemented here: the caller passes
 * the result of `getCatalogue()`, which is the single place that decision lives (Requirement
 * 2.11). Re-deriving it would be a second copy of the rule and therefore a second place for a
 * draft to leak into public search.
 *
 * The index is written as a **content-addressed** static asset (`/search-index/{hash}.json`)
 * so it can be cached immutably and so a content change produces a new URL rather than a
 * stale cached one. The hash is computed from the serialized bytes with a pure function — no
 * `node:crypto` — because this module is imported by page templates and must not drag a Node
 * built-in into any bundle.
 *
 * Design: Catalogue → Client-side, with a measured budget and a defined escape hatch.
 * Requirements: 2.11, 22.7, 22.8, 22.14.
 */

import { derivativeUrl } from '@/lib/images/srcset';
import { primaryImageOf } from '@/schemas/product';
import type { Product } from '@/schemas/product';
import { PRODUCT_FLAGS } from './types';
import type { SearchDoc } from './types';

/** The width the suggestion thumbnail is served at: a 48–56 px slot on a 2× screen. */
const THUMB_WIDTH = 320;

/** The flag bitmask for one product, in the design's bit order. */
export function flagsOf(product: Product): number {
  return (
    (product.featured ? PRODUCT_FLAGS.featured : 0) |
    (product.trending ? PRODUCT_FLAGS.trending : 0) |
    (product.bestSeller ? PRODUCT_FLAGS.bestSeller : 0) |
    (product.newArrival ? PRODUCT_FLAGS.newArrival : 0) |
    (product.madeToOrder ? PRODUCT_FLAGS.madeToOrder : 0)
  );
}

/** Colours the product can be searched by: its own colour plus every available colour. */
export function coloursOf(product: Product): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [product.color, ...product.availableColors]) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/**
 * Epoch **seconds**, not milliseconds: three digits per product saved, and the Newest sort
 * has no use for sub-second resolution. An unparseable date becomes 0 rather than `NaN`, so a
 * hand-edited file cannot produce a document that breaks the comparator.
 */
function epochSeconds(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? Math.floor(value / 1000) : 0;
}

/** Omit rather than emit `undefined`: `JSON.stringify` drops it anyway, and this is explicit. */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? {} : { [key]: trimmed };
}

export function toSearchDoc(product: Product): SearchDoc {
  const primary = primaryImageOf(product);
  return {
    i: product.slug,
    n: product.name,
    k: product.sku,
    c: product.category,
    ...optional('s', product.subcategory),
    ...optional('m', product.material),
    o: coloursOf(product),
    t: product.tags,
    p: product.priceOnEnquiry ? null : product.price,
    st: product.stockStatus,
    f: flagsOf(product),
    ts: epochSeconds(product.createdAt),
    th: primary === null ? '' : derivativeUrl(product.id, primary.id, THUMB_WIDTH, 'webp'),
    lq: primary?.lqip ?? '',
    ...optional('sz', product.size),
  };
}

/**
 * The index, ordered newest-first.
 *
 * A defined order is not cosmetic: it makes the serialized bytes — and therefore the content
 * hash and the asset URL — a function of the catalogue alone, so two builds of the same
 * content produce the same URL and the browser cache survives a redeploy.
 */
export function buildSearchIndex(products: readonly Product[]): SearchDoc[] {
  return products
    .map(toSearchDoc)
    .sort((a, b) => b.ts - a.ts || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
}

/** Serialized form. No whitespace: this is a wire format, not a file to read. */
export function serializeSearchIndex(docs: readonly SearchDoc[]): string {
  return JSON.stringify(docs);
}

/* -------------------------------------------------------------------------- */
/* Content addressing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a over UTF-16 code units, as 8 lowercase hex characters.
 *
 * A cache-busting fingerprint, not a security primitive: the only requirement is that two
 * different indexes get different URLs with overwhelming probability, and that the function is
 * pure and available in Node, in the Worker, and in the browser without an import.
 */
export function searchIndexHash(serialized: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    // 16777619, as shifts, to stay inside 32-bit integer arithmetic.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The public URL of an index with this hash. The one place the path shape is written. */
export function searchIndexPath(hash: string): string {
  return `/search-index/${hash}.json`;
}
