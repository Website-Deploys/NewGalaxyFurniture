/**
 * The canonical product schema — the single definition of what a product is.
 *
 * It is read in three places, so a product that is valid in one is valid in all
 * three: the Astro content collection loader (build-time gate), the admin write
 * endpoint (request-time gate), and `scripts/validate-content.ts` (CI gate).
 *
 * Two structural choices carry weight:
 *
 * - `.passthrough()` — unknown keys are preserved, never dropped. A product file
 *   authored by a future schema version, or by a human adding a field by hand,
 *   still validates and still round-trips through an admin edit. The frontend
 *   reads only known fields, so an extra key is inert.
 * - `.superRefine(enforceProductInvariants)` — the cross-field rules that no
 *   per-field type can express. Each one reports against the failing field.
 *
 * Deviation from the design's code block, semantics unchanged: the design writes
 * `ProductSchema = z.object({…}).passthrough().superRefine(enforceProductInvariants)`
 * with `enforceProductInvariants(p: Product, …)`. Written literally that is a
 * circular type reference (`Product` is inferred from the schema that references
 * the function that is annotated with `Product`). The object schema is therefore
 * named `ProductObject` first and the invariant function is typed against its
 * output. The composed schema, the field list, and the invariants are identical.
 *
 * Design: Data Models → Canonical product schema, Cross-field invariants.
 * Requirements: 13.9, 13.10, 13.11, 14.1, 14.7, 14.8, 14.14, 14.15, 17.1, 17.9.
 */

import { z } from 'zod';

import { issue } from './issue';

export const ProductStatus = z.enum([
  'DRAFT',
  'REVIEW',
  'PUBLISHED',
  'UNPUBLISHED',
  'OUT_OF_STOCK',
]);

export const StockStatus = z.enum(['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK', 'MADE_TO_ORDER']);

/** The three derivative formats the delivery route negotiates between. */
export const DerivativeFormat = z.enum(['avif', 'webp', 'jpeg']);

/**
 * The media record.
 *
 * The seven fields the design lists are required. The pipeline fields below are
 * **optional, with no Zod default**, and that is deliberate rather than lazy: a
 * `.default()` would materialise the key on every parse, so a product file written
 * before the image pipeline existed would gain keys it never had, and the "a JSON
 * round-trip is the identity" property (Property 12) would stop holding for records
 * authored by hand. Absent therefore reads as "not known yet", which for
 * `derivativesReady` is exactly the state the admin UI shows as "optimizing".
 */
export const ProductImage = z.object({
  id: z.string().regex(/^img_[a-z0-9]{10}$/),
  key: z.string(), // R2 object key of the original
  alt: z.string().max(180).default(''),
  width: z.number().int().positive(), // intrinsic dims — required, prevents CLS
  height: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  altSource: z.enum(['admin', 'ai']).default('admin'),

  /** Content type of the stored original, so `/img/**` can serve it byte-for-byte. */
  mime: z.string().max(60).optional(),
  /** The client's filename, sanitized, kept as a display label only — never a path. */
  filename: z.string().max(180).optional(),
  /** 24 px WebP data URL, inlined so a card or gallery never paints empty. */
  lqip: z.string().max(4000).optional(),
  /** False/absent while derivatives are still being written to R2. */
  derivativesReady: z.boolean().optional(),
  /** The widths actually stored. Never wider than `width`. */
  derivativeWidths: z.array(z.number().int().positive()).max(12).optional(),
  /** The formats actually stored at those widths. */
  derivativeFormats: z.array(DerivativeFormat).max(3).optional(),
});

export const Dimensions = z
  .object({
    lengthCm: z.number().positive().optional(),
    widthCm: z.number().positive().optional(),
    heightCm: z.number().positive().optional(),
    depthCm: z.number().positive().optional(),
    display: z.string().max(120).optional(), // e.g. "7 ft × 3 ft × 2.5 ft"
  })
  .partial();

export const ProductVariant = z.object({
  id: z.string(),
  label: z.string(), // "3 Seater", "Queen"
  sku: z.string().optional(),
  priceDelta: z.number().int().optional(),
  stockStatus: StockStatus.optional(),
});

const ProductObject = z
  .object({
    // identity
    id: z.string().regex(/^p_[a-z0-9]{10}$/),
    sku: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),

    // classification
    name: z.string().min(2).max(120),
    category: z.string(), // must resolve to data/categories/{slug}.json
    subcategory: z.string().optional(),
    tags: z.array(z.string()).max(24).default([]),

    // copy
    description: z.string().min(20).max(6000),
    shortDescription: z.string().max(240).optional(),

    // pricing (INR, integer paise-free rupees)
    currency: z.literal('INR').default('INR'),
    price: z.number().int().positive().nullable(), // null ⇒ price on enquiry
    priceOnEnquiry: z.boolean().default(false),
    originalPrice: z.number().int().positive().nullable().default(null),
    discount: z.number().int().min(0).max(95).nullable().default(null), // derived, never authored freely

    // inventory
    stockStatus: StockStatus,
    madeToOrder: z.boolean().default(false),

    // attributes
    material: z.string().max(120).optional(),
    color: z.string().max(60).optional(),
    availableColors: z.array(z.string().max(60)).max(20).default([]),
    dimensions: Dimensions.optional(),
    size: z.string().max(60).optional(),
    variants: z.array(ProductVariant).max(20).default([]),
    customization: z.string().max(2000).optional(),
    deliveryInformation: z.string().max(2000).optional(),

    // media
    images: z.array(ProductImage).max(20).default([]),
    primaryImage: z.string().optional(), // ProductImage.id; defaults to lowest order
    imageAltText: z.string().max(180).optional(), // legacy/simple alt for OG image

    // merchandising
    featured: z.boolean().default(false),
    trending: z.boolean().default(false),
    bestSeller: z.boolean().default(false),
    newArrival: z.boolean().default(false),
    relatedProductIds: z.array(z.string()).max(12).default([]),

    // lifecycle
    status: ProductStatus,
    published: z.boolean().default(false), // derived mirror of status, see invariants

    // SEO
    seoTitle: z.string().max(70).optional(),
    seoDescription: z.string().max(170).optional(),
    keywords: z.array(z.string()).max(20).default([]),

    // provenance
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    aiAssisted: z.boolean().default(false),
    aiFields: z.array(z.string()).default([]), // field paths whose value originated from AI
  })
  .passthrough(); // ← unknown-field tolerance: extra keys are preserved, never dropped

/** The parsed shape the invariants operate on. */
type ProductFields = z.output<typeof ProductObject>;

/**
 * The six cross-field invariants. Invariant 7 (slug/name coherence) is
 * deliberately advisory and not enforced: a rename must not break a live URL.
 */
export function enforceProductInvariants(p: ProductFields, ctx: z.RefinementCtx): void {
  // 1. price XOR priceOnEnquiry
  if (p.priceOnEnquiry && p.price !== null) {
    issue(ctx, 'price', 'Clear price when using price-on-enquiry');
  }
  if (!p.priceOnEnquiry && p.price === null) {
    issue(ctx, 'price', 'Set a price or mark price-on-enquiry');
  }

  // 2. no fake discounts: originalPrice must exceed price, and discount is derived
  if (p.originalPrice !== null) {
    if (p.price === null || p.originalPrice <= p.price) {
      issue(ctx, 'originalPrice', 'Original price must be higher than the current price');
    }
    // The computed percentage is only meaningful once a price exists; the design's
    // expression divides by `originalPrice` using `price`, which is unreachable
    // arithmetic (NaN) in the null case already reported above.
    if (p.price !== null) {
      const expected = Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100);
      if (p.discount !== null && p.discount !== expected) {
        issue(ctx, 'discount', `Discount must equal the computed ${expected}%`);
      }
    }
  } else if (p.discount !== null) {
    issue(ctx, 'discount', 'Discount requires an original price');
  }

  // 3. status ⟺ published mirror, and OUT_OF_STOCK consistency
  if (p.published !== (p.status === 'PUBLISHED' || p.status === 'OUT_OF_STOCK')) {
    issue(ctx, 'published', 'published must mirror status');
  }
  if ((p.status === 'OUT_OF_STOCK') !== (p.stockStatus === 'OUT_OF_STOCK')) {
    issue(ctx, 'status', 'status OUT_OF_STOCK requires stockStatus OUT_OF_STOCK and vice versa');
  }

  // 4. made-to-order coherence
  if (p.madeToOrder && p.stockStatus !== 'MADE_TO_ORDER') {
    issue(ctx, 'stockStatus', 'madeToOrder products must use MADE_TO_ORDER stock status');
  }

  // 5. primaryImage must reference an owned image
  if (p.primaryImage !== undefined && !p.images.some((i) => i.id === p.primaryImage)) {
    issue(ctx, 'primaryImage', 'primaryImage must reference one of this product’s images');
  }

  // 6. image order is a permutation of 0..n-1
  const orders = p.images.map((i) => i.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i)) {
    issue(ctx, 'images', 'Image order must be contiguous from 0');
  }
}

export const ProductSchema = ProductObject.superRefine(enforceProductInvariants);

export type Product = z.infer<typeof ProductSchema>;
export type ProductStatusValue = z.infer<typeof ProductStatus>;
export type StockStatusValue = z.infer<typeof StockStatus>;
export type ProductImageValue = z.infer<typeof ProductImage>;
export type DerivativeFormatValue = z.infer<typeof DerivativeFormat>;

/** Absent reads as "not ready" — see the note on `ProductImage`. */
export function derivativesReadyOf(image: Pick<ProductImageValue, 'derivativesReady'>): boolean {
  return image.derivativesReady === true;
}

/**
 * The image a surface should lead with: the explicitly designated primary, else the
 * lowest `order` (which the contiguity invariant makes `order === 0`).
 */
export function primaryImageOf(
  product: Pick<Product, 'images' | 'primaryImage'>,
): ProductImageValue | null {
  if (product.images.length === 0) return null;
  const designated = product.images.find((image) => image.id === product.primaryImage);
  if (designated !== undefined) return designated;
  return [...product.images].sort((a, b) => a.order - b.order)[0] ?? null;
}
export type ProductVariantValue = z.infer<typeof ProductVariant>;
export type DimensionsValue = z.infer<typeof Dimensions>;

/**
 * The two statuses that make a product part of the public catalogue.
 * `OUT_OF_STOCK` stays live and indexable with degraded CTAs — see the design's
 * note on OUT_OF_STOCK as a lifecycle status.
 */
export const PUBLIC_STATUSES: readonly ProductStatusValue[] = ['PUBLISHED', 'OUT_OF_STOCK'];
