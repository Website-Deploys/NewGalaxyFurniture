/**
 * The compact document the browser searches, filters, and sorts.
 *
 * Short keys are deliberate and load-bearing rather than cosmetic: the index is fetched by
 * every visitor who types in the header search, and `"category"` repeated 500 times costs
 * more than `"c"` repeated 500 times even after Brotli, because the compressor pays for the
 * literal once but for the *position* of every repeat. At ~200 bytes per product the whole
 * catalogue stays well inside the 60 KB Brotli budget the build asserts.
 *
 * **One documented deviation from the design's `SearchDoc`.** The design lists the keys
 * `i,n,k,c,s,m,o,t,p,st,f,ts,th,lq` — with no field for the product's `size`. But Requirement
 * 3.1 mandates a **size** filter dimension alongside category, price band, availability,
 * material, colour, and style, and Requirement 3.7 requires its option list and counts to be
 * derived from catalogue data at runtime. A dimension whose values are not in the index cannot
 * be derived from it, so `sz` is added. It is the minimum change that makes the required seven
 * dimensions implementable: one optional short key, absent on every product that has no size.
 *
 * Design: Catalogue → Client-side, with a measured budget and a defined escape hatch.
 * Requirements: 3.1, 3.7, 22.7, 22.8.
 */

export interface SearchDoc {
  /** Slug — also the document id in the index and the PDP path segment. */
  i: string;
  /** Name. */
  n: string;
  /** SKU. */
  k: string;
  /** Category slug. */
  c: string;
  /** Subcategory. */
  s?: string;
  /** Material. */
  m?: string;
  /** Colours: `color` plus `availableColors`, de-duplicated. */
  o: string[];
  /** Tags — the source of the style facet. */
  t: string[];
  /** Price in whole rupees; `null` means price on enquiry. */
  p: number | null;
  /** Stock status. */
  st: string;
  /** Flag bitmask — see `PRODUCT_FLAGS`. */
  f: number;
  /** `createdAt` as epoch seconds, for the Newest sort. */
  ts: number;
  /**
   * The suggestion thumbnail, stored as a resolved `/img/**` URL rather than as a bare image
   * id. The design's comment names this field "primary image id", but an image id alone cannot
   * address an image: the delivery route is `/img/{productId}/{imageId}-{width}.{format}`, so
   * the product id and the width would both have to be carried too. One resolved URL is fewer
   * bytes than three fields and cannot be assembled wrongly by a caller. Empty when the
   * product has no image.
   */
  th: string;
  /** LQIP data URI. Empty when the product has no image. */
  lq: string;
  /** Size label. See the deviation note above. */
  sz?: string;
}

/**
 * The flag bitmask, in the design's order.
 *
 * A bitmask rather than five booleans because five `"featured":false` pairs per product is
 * ~120 bytes of nothing; one integer is two.
 */
export const PRODUCT_FLAGS = {
  featured: 1,
  trending: 2,
  bestSeller: 4,
  newArrival: 8,
  madeToOrder: 16,
} as const;

export type ProductFlag = keyof typeof PRODUCT_FLAGS;

export function hasFlag(doc: Pick<SearchDoc, 'f'>, flag: ProductFlag): boolean {
  return (doc.f & PRODUCT_FLAGS[flag]) !== 0;
}

/** The PDP path for a document. The one place the product URL shape is written. */
export function productHref(doc: Pick<SearchDoc, 'i'>): string {
  return `/product/${doc.i}`;
}
