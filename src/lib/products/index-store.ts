/**
 * The KV product index — one record per product, enough to draw the admin list.
 *
 * The design's state table says draft state lives in KV so the admin gets "a fast admin
 * list without GitHub API round-trips". Drafts alone cannot deliver that: a published
 * product has no KV draft, so listing the catalogue from KV drafts plus GitHub would be
 * one API call per published product per page view. This index closes that gap. It holds
 * only what the list view renders plus the id → slug mapping the resolver needs.
 *
 * Three properties keep it honest:
 *
 * - **It is a cache, never a source of truth.** Every field is a copy of a field in
 *   `data/products/{slug}.json`, and `POST /api/admin/rehydrate` rebuilds the whole index
 *   from the repository. A lost or stale entry is recoverable, not fatal.
 * - **It is written by the same call that commits.** `saveProductState` updates it after a
 *   successful write, so an index entry implies a commit happened.
 * - **It carries no figure the dashboard could not derive from a stored record.** The
 *   counts on `/admin` are computed from these entries, which are copies of stored
 *   product fields — no metric is invented here (Requirement 11.3).
 *
 * Design: Write Pipeline → State → repository mapping.
 * Requirements: 11.2, 11.3, 12.2, 12.13, 17.19.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { parseContentJson } from '../github/serialize';
import { primaryImageOf, type Product, type ProductStatusValue } from '@/schemas/product';
import type { StockStatusValue } from '@/schemas/product';

/** The KV key the whole index lives under. One key, one read per list view. */
export const PRODUCT_INDEX_KEY = 'index:products';

/** The row the product table renders, and the record `resolveProduct` reads the slug from. */
export interface ProductSummary {
  id: string;
  slug: string;
  sku: string;
  name: string;
  category: string;
  subcategory?: string;
  status: ProductStatusValue;
  stockStatus: StockStatusValue;
  updatedAt: string;
  createdAt: string;
  price: number | null;
  priceOnEnquiry: boolean;
  imageCount: number;
  /** Just enough of the primary image to draw a thumbnail without a second lookup. */
  thumbnail: {
    productId: string;
    imageId: string;
    alt: string;
    width: number;
    height: number;
    lqip?: string;
    derivativesReady: boolean;
  } | null;
  aiAssisted: boolean;
}

export type ProductIndex = Record<string, ProductSummary>;

function isSummary(value: unknown): value is ProductSummary {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.slug === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.name === 'string'
  );
}

/** Project a stored product down to its list row. */
export function summarize(product: Product): ProductSummary {
  const primary = primaryImageOf(product);
  return {
    id: product.id,
    slug: product.slug,
    sku: product.sku,
    name: product.name,
    category: product.category,
    ...(product.subcategory === undefined ? {} : { subcategory: product.subcategory }),
    status: product.status,
    stockStatus: product.stockStatus,
    updatedAt: product.updatedAt,
    createdAt: product.createdAt,
    price: product.price,
    priceOnEnquiry: product.priceOnEnquiry,
    imageCount: product.images.length,
    thumbnail:
      primary === null
        ? null
        : {
            productId: product.id,
            imageId: primary.id,
            alt: primary.alt,
            width: primary.width,
            height: primary.height,
            ...(primary.lqip === undefined ? {} : { lqip: primary.lqip }),
            derivativesReady: primary.derivativesReady === true,
          },
    aiAssisted: product.aiAssisted,
  };
}

export async function readProductIndex(kv: KVNamespace): Promise<ProductIndex> {
  const raw = await kv.get(PRODUCT_INDEX_KEY, 'text');
  const parsed = raw === null ? null : parseContentJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const index: ProductIndex = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A row that no longer deserializes is dropped rather than returned half-typed:
    // the repository still holds the product, and `rehydrate` will restore the row.
    if (isSummary(value)) index[id] = value;
  }
  return index;
}

export async function writeProductIndex(kv: KVNamespace, index: ProductIndex): Promise<void> {
  await kv.put(PRODUCT_INDEX_KEY, JSON.stringify(index));
}

/**
 * Insert or replace one row.
 *
 * The whole index is one KV value, so this is a read-modify-write and KV has no
 * compare-and-set: two saves of *different* products landing in the same instant can lose one
 * of the two rows. That is accepted deliberately, and the reasoning is the same as for the write
 * lock in `client.ts` — the index is a cache, the repository is the authority, and the visible
 * consequence of a lost row is one product missing from the admin list until the next save or a
 * `POST /api/admin/rehydrate`. Making it exact would mean a KV key per product and a `list` per
 * page view, which is the cost this index exists to avoid. Concurrent saves of the *same*
 * product are already serialised by the lock.
 */
export async function rememberProduct(kv: KVNamespace, product: Product): Promise<void> {
  const index = await readProductIndex(kv);
  index[product.id] = summarize(product);
  await writeProductIndex(kv, index);
}

export async function forgetProduct(kv: KVNamespace, productId: string): Promise<void> {
  const index = await readProductIndex(kv);
  if (!(productId in index)) return;
  delete index[productId];
  await writeProductIndex(kv, index);
}

/** The stored slug for an id, or undefined. The resolver's minimal contract. */
export async function productSlugFor(
  kv: KVNamespace,
  productId: string,
): Promise<string | undefined> {
  const index = await readProductIndex(kv);
  return index[productId]?.slug;
}

export async function listProductSummaries(kv: KVNamespace): Promise<ProductSummary[]> {
  return Object.values(await readProductIndex(kv));
}

/**
 * Every slug and SKU currently in use, for `uniqueSlug` and `generateSku`.
 *
 * Read from the index rather than from the repository because a collision must be
 * avoided against drafts too — a draft occupies its filename the moment it is committed.
 */
export interface TakenIdentifiers {
  readonly slugs: ReadonlySet<string>;
  readonly skus: ReadonlySet<string>;
}

export async function takenIdentifiers(
  kv: KVNamespace,
  options: { exceptProductId?: string } = {},
): Promise<TakenIdentifiers> {
  const index = await readProductIndex(kv);
  const slugs = new Set<string>();
  const skus = new Set<string>();
  for (const summary of Object.values(index)) {
    if (summary.id === options.exceptProductId) continue;
    slugs.add(summary.slug);
    skus.add(summary.sku);
  }
  return { slugs, skus };
}
