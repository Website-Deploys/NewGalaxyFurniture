/**
 * Server-side resolution of an enquiry's product reference.
 *
 * Requirement 6.6 is a trust rule: a lead's product name, SKU and canonical URL are
 * resolved on the server from the referenced identifier, and never taken from the browser.
 * This module is the whole of that resolution, and its signature is what enforces it — it
 * takes a slug and a catalogue and returns the three resolved values. There is no parameter
 * a client-supplied name or SKU could arrive in, so no call site can pass one by accident.
 *
 * The catalogue it is given is `getCatalogue()`'s output, which is the single
 * `PUBLISHED`/`OUT_OF_STOCK` filter every public surface reads. That is what makes
 * Requirement 6.17 fall out for free: a slug that names a draft, an unpublished product, or
 * a product that never existed is *equally* unresolvable here, and all three produce the
 * same "no longer available" answer with a route back to the Catalogue. An enquiry about a
 * draft must not be accepted, and distinguishing "draft" from "deleted" in the response
 * would leak the state of unpublished content to anyone who can guess a slug.
 *
 * `OUT_OF_STOCK` resolves successfully and deliberately: a piece that is temporarily out of
 * stock is exactly the thing someone enquires about, and refusing the enquiry would throw
 * away the lead that could become a made-to-order sale.
 *
 * Requirements: 6.6, 6.17.
 */

import type { Product } from '@/schemas/product';

/** The path a product's page lives at. One definition, shared with the sitemap's shape. */
export function productPath(slug: string): string {
  return `/product/${slug}`;
}

export interface ResolvedProduct {
  slug: string;
  name: string;
  sku: string;
  /** Absolute, built from `PUBLIC_SITE_URL` — never a hard-coded origin. */
  url: string;
}

export type ProductResolution =
  | { readonly ok: true; readonly product: ResolvedProduct }
  | { readonly ok: false; readonly reason: 'not-in-catalogue' };

/**
 * Resolve a slug against the Catalogue.
 *
 * @param siteUrl the canonical origin, with no trailing slash, from `getPublicConfig`.
 */
export function resolveProductReference(
  slug: string,
  catalogue: readonly Product[],
  siteUrl: string,
): ProductResolution {
  const product = catalogue.find((candidate) => candidate.slug === slug);
  if (product === undefined) return { ok: false, reason: 'not-in-catalogue' };

  const path = productPath(product.slug);
  return {
    ok: true,
    product: {
      slug: product.slug,
      name: product.name,
      sku: product.sku,
      url: `${siteUrl.replace(/\/$/, '')}${path}`,
    },
  };
}
