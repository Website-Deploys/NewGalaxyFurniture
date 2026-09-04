/**
 * Product duplication.
 *
 * "Duplicate" is the operator's shortcut for "another item like this one", and its
 * one hard requirement is that it cannot damage the original (requirement 12.6).
 * Two independent guarantees cover that:
 *
 * 1. **Here**: the copy is deep — `images`, `tags`, `variants`, `availableColors`,
 *    `relatedProductIds`, `keywords`, `aiFields`, and `dimensions` are cloned, so no
 *    nested array or object is shared with the source, and the source object is
 *    never written to.
 * 2. **In the write pipeline**: the copy's path is derived from its new slug, and a
 *    create carries no blob SHA, so GitHub refuses an overwrite. Even a logic bug
 *    here cannot clobber the source file.
 *
 * Design: Data Models → Slug and SKU generation ("Duplicate must not overwrite the
 * original").
 * Requirements: 12.5, 12.6.
 */

import { generateSku, uniqueSlug } from '@/lib/slug';
import type { Product } from '@/schemas/product';

/** The identifiers already in use across the catalogue. */
export interface TakenIdentifiers {
  readonly slugs: ReadonlySet<string>;
  readonly skus: ReadonlySet<string>;
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `p_` + 10 lowercase alphanumerics, matching the schema's id pattern.
 *
 * WebCrypto only, with no `Math.random` fallback — a product id is the permanent key every
 * lead, analytics row, and related-product reference points at, and it must not be minted from
 * a weaker source because an environment looked unusual. Every supported runtime has
 * `crypto.getRandomValues`; its absence is a fault to report, not to work around.
 */
export function generateProductId(): string {
  const bytes = new Uint8Array(10);
  const webcrypto = globalThis.crypto;
  if (typeof webcrypto?.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable — cannot generate a product id.');
  }
  webcrypto.getRandomValues(bytes);
  let out = 'p_';
  for (let i = 0; i < bytes.length; i += 1)
    out += LOWER_ALNUM[(bytes[i] ?? 0) % LOWER_ALNUM.length];
  return out;
}

/**
 * Deep-copy `source` as a fresh draft.
 *
 * On stock status: the schema couples `status OUT_OF_STOCK` with
 * `stockStatus OUT_OF_STOCK` in both directions, so a `DRAFT` record cannot carry
 * `OUT_OF_STOCK` stock. Duplicating an out-of-stock product therefore cannot
 * preserve that value; the copy is a *new record*, so it takes the new-record
 * default `IN_STOCK`, which the operator confirms before publishing (the publish
 * gate requires a stock status, and the admin form shows it). Every other stock
 * status is preserved exactly.
 */
export function duplicateProduct(
  source: Product,
  taken: TakenIdentifiers,
  now: Date = new Date(),
): Product {
  // structuredClone gives a true deep copy of every JSON-representable value,
  // including unknown passthrough fields, without a JSON round-trip.
  const copy = structuredClone(source);

  const timestamp = now.toISOString();

  copy.id = generateProductId();
  copy.sku = generateSku(source.category, taken.skus);
  copy.slug = uniqueSlug(`${source.name} copy`, taken.slugs);
  copy.status = 'DRAFT';
  copy.published = false;
  copy.stockStatus = source.stockStatus === 'OUT_OF_STOCK' ? 'IN_STOCK' : source.stockStatus;
  copy.createdAt = timestamp;
  copy.updatedAt = timestamp;

  return copy;
}
