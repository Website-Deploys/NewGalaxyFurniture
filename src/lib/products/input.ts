/**
 * What an admin request is allowed to say about a product, and how a stored product is
 * derived from it.
 *
 * The endpoints do not accept a `Product`. They accept these narrower inputs, and the
 * server builds the record. That distinction carries the requirements that no client can
 * be trusted with:
 *
 * - **Identity is server-generated.** `id`, `slug` and `sku` are not in either input
 *   schema, so no request can set or change them; create derives them from the name and
 *   category (Requirement 13.13) and a rename is its own confirmed operation
 *   (Requirements 12.11, 12.12).
 * - **Lifecycle is not a field.** `status` and `published` are absent, so the only way to
 *   change status is `POST /transition`, which is where the gate and the permission live
 *   (Requirements 14.3, 14.10). A `PATCH` cannot publish anything.
 * - **Derived values cannot be authored.** `discount` is computed from price and original
 *   price and is rejected as an input, which is what makes Requirement 13.10 ("shall not
 *   accept a discount inconsistent with those two values") true by construction rather
 *   than by check.
 * - **Images are not patchable here.** They have their own endpoints, because an image
 *   arrives as bytes and its record carries server-generated keys and dimensions.
 *   `primaryImage` *is* patchable, and is validated against the product's own images by
 *   the schema invariant.
 *
 * Every function in this module is pure and total: the form and the endpoint run the same
 * normalization, so the values the operator sees are the values that get stored.
 *
 * Design: Data Models → Canonical product schema; Write Pipeline → Endpoint contracts.
 * Requirements: 12.1, 12.3, 13.1–13.13, 17.7, 17.8, 17.19, 25.1.
 */

import { z } from 'zod';

import { generateProductId } from './duplicate';
import { generateSku, uniqueSlug } from '@/lib/slug';
import {
  Dimensions,
  ProductSchema,
  ProductVariant,
  StockStatus,
  type Product,
} from '@/schemas/product';
import type { TakenIdentifiers } from './index-store';

/* -------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The editable surface, field for field the seven groups of Requirement 13.
 *
 * Bounds mirror `ProductSchema` exactly rather than being re-guessed, so a value the form
 * accepts is a value the canonical schema accepts. Nullable numeric fields are nullable
 * here too: the form has to be able to *clear* a price, and `null` is how it says so.
 */
const EditableFields = z.object({
  // Basic Information
  name: z.string().min(2).max(120),
  category: z.string().min(1),
  subcategory: z.string().max(120).nullable(),
  description: z.string().max(6000),
  shortDescription: z.string().max(240).nullable(),

  // Pricing. `discount` is deliberately absent — it is derived.
  price: z.number().int().positive().nullable(),
  priceOnEnquiry: z.boolean(),
  originalPrice: z.number().int().positive().nullable(),

  // Product
  material: z.string().max(120).nullable(),
  color: z.string().max(60).nullable(),
  availableColors: z.array(z.string().max(60)).max(20),
  dimensions: Dimensions.nullable(),
  size: z.string().max(60).nullable(),
  variants: z.array(ProductVariant).max(20),
  customization: z.string().max(2000).nullable(),
  deliveryInformation: z.string().max(2000).nullable(),

  // Inventory
  stockStatus: StockStatus,
  madeToOrder: z.boolean(),

  // Marketing
  featured: z.boolean(),
  trending: z.boolean(),
  bestSeller: z.boolean(),
  newArrival: z.boolean(),
  tags: z.array(z.string().max(60)).max(24),
  relatedProductIds: z.array(z.string()).max(12),

  // SEO
  seoTitle: z.string().max(70).nullable(),
  seoDescription: z.string().max(170).nullable(),
  keywords: z.array(z.string().max(60)).max(20),

  // Images: only the designation is editable here.
  primaryImage: z.string().nullable(),
  imageAltText: z.string().max(180).nullable(),
});

export type EditableProductFields = z.infer<typeof EditableFields>;

/**
 * Create needs a name and a category and nothing else (Requirement 12.3: an incomplete
 * product is storable as a draft). `description` is relaxed to any string here because the
 * canonical schema's 20-character minimum is a *publish* concern, not a draft one — the
 * publish gate enforces it, and forcing it at create would make "save and come back to it"
 * impossible.
 */
export const ProductCreateInput = EditableFields.partial()
  .extend({
    name: z.string().min(2).max(120),
    category: z.string().min(1),
    /**
     * Provenance, accepted at create only.
     *
     * Deliberately outside `EditableFields`, so a later `PATCH` cannot rewrite it: provenance is
     * a record of how the first version of this product came to exist, and a product whose
     * history is editable has no history. The AI assistant sets both when the operator creates a
     * product from a suggestion (Requirements 16.4, 14.11); the manual form sends neither and
     * gets the `false`/`[]` defaults.
     *
     * Note what is still absent: `status`. The create endpoint always produces `DRAFT`, so the
     * AI flow has no route to a published product regardless of what it asks for
     * (Requirement 16.11).
     */
    aiAssisted: z.boolean().optional(),
    aiFields: z.array(z.string().max(60)).max(40).optional(),
  })
  .strict();

export type ProductCreateInputValue = z.infer<typeof ProductCreateInput>;

/**
 * `expectedUpdatedAt` is the optimistic-concurrency token: the `updatedAt` the operator
 * loaded. A mismatch is a conflict, which is refused rather than merged (Requirement
 * 17.10). `confirmSlugChange` is the operator's explicit acceptance that a rename will
 * move the product's web address (Requirements 12.11, 12.12).
 */
export const ProductPatchInput = z
  .object({
    /**
     * `.strict()`, not merely partial.
     *
     * Zod's default is to *strip* unknown keys, which would mean a patch carrying
     * `status: 'PUBLISHED'` or `discount: 90` returned `200` with those keys quietly
     * discarded — the right outcome by accident, reported as if the request had been honoured.
     * Refusing the request instead makes the boundary legible: a field that cannot be patched
     * comes back as a validation error naming it. A property test found this case.
     */
    patch: EditableFields.partial().strict(),
    expectedUpdatedAt: z.string().min(1),
    confirmSlugChange: z.boolean().optional(),
  })
  .strict();

export type ProductPatchInputValue = z.infer<typeof ProductPatchInput>;

export const ProductDeleteInput = z.object({ confirmSlug: z.string().min(1) }).strict();

export const ProductTransitionInput = z
  .object({
    to: z.enum(['DRAFT', 'REVIEW', 'PUBLISHED', 'UNPUBLISHED', 'OUT_OF_STOCK']),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** The discount the schema will accept for a price pair, or null when there is none. */
export function derivedDiscount(price: number | null, originalPrice: number | null): number | null {
  if (price === null || originalPrice === null) return null;
  if (originalPrice <= price) return null;
  return Math.round(((originalPrice - price) / originalPrice) * 100);
}

/**
 * Force the record's derived fields into agreement with its authored ones.
 *
 * This runs on every create and every patch, before validation, and it is the reason the
 * form never has to send a consistent record — it sends what the operator typed and the
 * server makes it coherent:
 *
 * - price-on-enquiry clears the numeric price and any strike-through (Requirement 13.11)
 * - `discount` is recomputed, never taken from input (Requirement 13.10)
 * - an `originalPrice` that does not exceed the price is *kept*, not silently dropped, so
 *   the schema reports it against the field the operator typed in (Requirement 13.9)
 * - `published` mirrors `status`, and image `order` is renumbered contiguously
 * - `madeToOrder` implies the made-to-order stock status
 */
export function normalizeProduct(draft: Product): Product {
  const priceOnEnquiry = draft.priceOnEnquiry;
  const price = priceOnEnquiry ? null : draft.price;
  const originalPrice = priceOnEnquiry ? null : draft.originalPrice;

  const images = [...draft.images]
    .sort((a, b) => a.order - b.order)
    .map((image, index) => ({ ...image, order: index }));

  const primaryImage =
    draft.primaryImage !== undefined && images.some((image) => image.id === draft.primaryImage)
      ? draft.primaryImage
      : images[0]?.id;

  return {
    ...draft,
    price,
    originalPrice,
    discount: derivedDiscount(price, originalPrice),
    stockStatus: draft.madeToOrder ? 'MADE_TO_ORDER' : draft.stockStatus,
    published: draft.status === 'PUBLISHED' || draft.status === 'OUT_OF_STOCK',
    images,
    ...(primaryImage === undefined ? {} : { primaryImage }),
  };
}

/** `null` from the form means "clear this optional field", i.e. remove the key. */
function applyOptional<T extends Record<string, unknown>>(
  target: T,
  patch: Record<string, unknown>,
  keys: readonly string[],
): void {
  const mutable = target as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) delete mutable[key];
    else mutable[key] = value;
  }
}

/** Fields the schema declares as `optional()` — absent, not null, is how they are cleared. */
const OPTIONAL_KEYS = [
  'subcategory',
  'shortDescription',
  'material',
  'color',
  'dimensions',
  'size',
  'customization',
  'deliveryInformation',
  'seoTitle',
  'seoDescription',
  'primaryImage',
  'imageAltText',
] as const;

/** Fields the schema declares as nullable — `null` is a value, not an absence. */
const NULLABLE_KEYS = ['price', 'originalPrice'] as const;

/** Fields with a non-null default: arrays, booleans, and the two enums. */
const PLAIN_KEYS = [
  'name',
  'category',
  'description',
  'priceOnEnquiry',
  'availableColors',
  'variants',
  'stockStatus',
  'madeToOrder',
  'featured',
  'trending',
  'bestSeller',
  'newArrival',
  'tags',
  'relatedProductIds',
  'keywords',
] as const;

export interface BuildProductOptions {
  taken: TakenIdentifiers;
  now?: Date;
}

/**
 * A new `DRAFT` product from the minimum the create endpoint requires.
 *
 * The publish gate is deliberately *not* applied (Requirement 12.3). The record still has
 * to satisfy the canonical schema, which is what `ProductSchema.safeParse` at the call
 * site checks — a draft may be incomplete, never incoherent.
 */
export function buildNewProduct(
  input: ProductCreateInputValue,
  options: BuildProductOptions,
): Product {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();

  const base: Record<string, unknown> = {
    id: generateProductId(),
    sku: generateSku(input.category, options.taken.skus),
    slug: uniqueSlug(input.name, options.taken.slugs),
    name: input.name,
    category: input.category,
    tags: [],
    // A draft with no copy yet: the schema's 20-character minimum applies to the
    // canonical record, so a placeholder-free empty description would fail validation.
    // The create endpoint therefore stores the operator's description when they gave one
    // and an explicit, honest marker when they did not — never invented product copy.
    description: input.description ?? DRAFT_DESCRIPTION_PLACEHOLDER,
    currency: 'INR',
    price: null,
    /**
     * A new product with no price starts as price-on-enquiry.
     *
     * The canonical schema requires a price *or* price-on-enquiry — the two are mutually
     * exclusive and one is mandatory — so a draft cannot simply have neither. Of the two
     * possible defaults, price-on-enquiry is the only one that invents nothing: the
     * alternative would be a placeholder amount on a real product. The operator turns it off
     * and types a price whenever they have one, and the publish gate accepts either state
     * (Requirement 14.4), so nothing is forced.
     */
    priceOnEnquiry: true,
    originalPrice: null,
    discount: null,
    stockStatus: 'IN_STOCK',
    madeToOrder: false,
    availableColors: [],
    variants: [],
    images: [],
    featured: false,
    trending: false,
    bestSeller: false,
    newArrival: false,
    relatedProductIds: [],
    status: 'DRAFT',
    published: false,
    keywords: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    // Provenance. `aiFields` is intersected with the keys this record actually carries below,
    // so a claim about a field the product does not have cannot be stored.
    aiAssisted: input.aiAssisted ?? false,
    aiFields: [],
  };

  const patch = input as unknown as Record<string, unknown>;
  for (const key of PLAIN_KEYS) {
    if (key in patch && patch[key] !== undefined && patch[key] !== null) base[key] = patch[key];
  }
  for (const key of NULLABLE_KEYS) {
    if (key in patch && patch[key] !== undefined) base[key] = patch[key];
  }
  applyOptional(base, patch, OPTIONAL_KEYS);

  // A create that supplies a price means a priced product, unless it says otherwise
  // explicitly. Without this, the price-on-enquiry default above would silently discard the
  // amount the operator typed on the creation form.
  if (input.priceOnEnquiry === undefined && typeof input.price === 'number') {
    base.priceOnEnquiry = false;
  }

  // Draft copy shorter than the schema minimum would make the record unstorable, and
  // rejecting a short description at create would defeat "save it and come back".
  const description = base.description;
  if (typeof description === 'string' && description.trim().length < 20) {
    base.description = `${description.trim()}\n\n${DRAFT_DESCRIPTION_PLACEHOLDER}`.trim();
  }

  // `aiFields` is filtered against the keys the stored record actually has, and against the
  // fields the create input can carry at all. A request claiming AI authorship of `status`, or of
  // a field it did not send, would otherwise put a false provenance record in the committed JSON —
  // and provenance is only worth having if it is true.
  if (input.aiFields !== undefined) {
    const storable: ReadonlySet<string> = new Set<string>([
      ...PLAIN_KEYS,
      ...NULLABLE_KEYS,
      ...OPTIONAL_KEYS,
    ]);
    base.aiFields = [...new Set(input.aiFields)]
      .filter((field) => storable.has(field) && field in base)
      .sort();
  }

  return normalizeProduct(base as unknown as Product);
}

/**
 * The one piece of copy this codebase writes into a product, and it is a marker rather
 * than content: it is visibly a to-do, it never reaches a public surface (the publish gate
 * requires 20 real characters *and* the operator has to look at this field to publish),
 * and it exists only because the canonical schema requires a description to be storable.
 */
export const DRAFT_DESCRIPTION_PLACEHOLDER =
  '[PLACEHOLDER — write the product description before publishing.]';

/** Apply an operator's patch to a stored product. Never mutates `current`. */
export function applyProductPatch(
  current: Product,
  patch: Partial<EditableProductFields>,
  now: Date = new Date(),
): Product {
  const next: Record<string, unknown> = { ...current };
  const raw = patch as Record<string, unknown>;

  for (const key of PLAIN_KEYS) {
    if (key in raw && raw[key] !== undefined && raw[key] !== null) next[key] = raw[key];
  }
  for (const key of NULLABLE_KEYS) {
    if (key in raw && raw[key] !== undefined) next[key] = raw[key];
  }
  applyOptional(next, raw, OPTIONAL_KEYS);

  next.updatedAt = now.toISOString();
  return normalizeProduct(next as unknown as Product);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export type FieldErrors = Record<string, string[]>;

/** Zod issues, keyed the way the admin form keys its controls. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [issue.message];
    else if (!bucket.includes(issue.message)) bucket.push(issue.message);
  }
  return fields;
}

/**
 * Server-side re-validation of a built record (Requirement 17.7, 25.1).
 *
 * Runs on create and on patch, regardless of what the client validated, and returns
 * field-keyed errors rather than throwing.
 */
export function validateProduct(
  candidate: unknown,
): { ok: true; product: Product } | { ok: false; fields: FieldErrors } {
  const parsed = ProductSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, product: parsed.data };
  return { ok: false, fields: fieldErrorsOf(parsed.error) };
}

/**
 * The slug a renamed product would take, or null when the name change does not move it.
 *
 * `taken` must exclude the product itself, otherwise every rename would collide with its
 * own current slug and get a `-2` suffix.
 */
export function proposedSlugFor(
  current: Product,
  nextName: string,
  taken: TakenIdentifiers,
): string | null {
  const proposed = uniqueSlug(nextName, taken.slugs);
  return proposed === current.slug ? null : proposed;
}
