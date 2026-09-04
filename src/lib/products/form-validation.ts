/**
 * The validation the editor runs as the operator types.
 *
 * It is the **same code the server runs**, not a second implementation of it: `fieldIssues`
 * builds the candidate record exactly as `applyProductPatch` would and hands it to
 * `ProductSchema`, and `publishBlockers` calls `checkPublishGate`. So a message the operator
 * sees inline is a message the server would have produced, keyed by the same field path —
 * which is what makes the form's inline errors and the API's `422 { fields }` renderable by
 * one piece of UI.
 *
 * A duplicated client-side rule set is the usual way this goes wrong: it drifts, and then the
 * form either blocks something the server accepts or accepts something the server refuses.
 * Neither is recoverable by the operator, so there is no second rule set here.
 *
 * Requirements: 13.9, 13.10, 13.11, 14.4, 14.5, 24.9, 26.9.
 */

import { checkPublishGate } from '@/schemas/publish-gate';
import { fieldErrorsOf, normalizeProduct, type FieldErrors } from './input';
import { ProductSchema, type Product } from '@/schemas/product';

/**
 * Field-level errors for a draft in progress.
 *
 * The candidate is normalized first, for the same reason the server normalizes: `discount` is
 * derived and `priceOnEnquiry` clears the price, so validating the raw form state would report
 * errors the save would never produce.
 *
 * Errors on `description` are dropped while the draft is short, because a 20-character
 * minimum is a *publish* requirement — flagging it on an empty new product would put a red
 * message on a field the operator has not reached yet. `publishBlockers` reports it at the
 * moment it matters.
 */
export function fieldIssues(draft: Product): FieldErrors {
  const parsed = ProductSchema.safeParse(normalizeProduct(draft));
  if (parsed.success) return {};
  const errors = fieldErrorsOf(parsed.error);
  if (draft.status === 'DRAFT' || draft.status === 'REVIEW') delete errors.description;
  return errors;
}

/** What stands between this draft and a public status, keyed by field. */
export function publishBlockers(draft: Product): FieldErrors {
  const candidate = normalizeProduct({
    ...draft,
    // The gate is asked about the *published* record: a draft's `published: false` would
    // otherwise fail the mirror invariant and mask the real blockers.
    status: 'PUBLISHED',
    published: true,
  });
  const gate = checkPublishGate(candidate);
  return gate.ok ? {} : gate.fields;
}

/** True when the draft could be published right now. */
export function isPublishReady(draft: Product): boolean {
  return Object.keys(publishBlockers(draft)).length === 0;
}

/**
 * The human name of a field path, for the summary at the top of the form.
 *
 * A summary that says `seoDescription` is a developer's error list. This is the operator's.
 */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Product name',
  category: 'Category',
  subcategory: 'Subcategory',
  description: 'Description',
  shortDescription: 'Short description',
  price: 'Price',
  priceOnEnquiry: 'Price on enquiry',
  originalPrice: 'Original price',
  discount: 'Discount',
  material: 'Material',
  color: 'Colour',
  availableColors: 'Available colours',
  dimensions: 'Dimensions',
  size: 'Size',
  variants: 'Variants',
  customization: 'Customization',
  deliveryInformation: 'Delivery information',
  stockStatus: 'Stock status',
  madeToOrder: 'Made to order',
  featured: 'Featured',
  trending: 'Trending',
  bestSeller: 'Best seller',
  newArrival: 'New arrival',
  tags: 'Tags',
  relatedProductIds: 'Related products',
  seoTitle: 'SEO title',
  seoDescription: 'SEO description',
  keywords: 'Keywords',
  images: 'Images',
  primaryImage: 'Primary image',
  sku: 'SKU',
  slug: 'Web address',
  status: 'Status',
  _: 'This product',
};

export function labelFor(path: string): string {
  const root = path.split('.')[0] ?? path;
  return FIELD_LABELS[path] ?? FIELD_LABELS[root] ?? root;
}

/** Which of the seven form groups a field belongs to — drives the error summary's links. */
export const FIELD_GROUPS: Record<string, string> = {
  name: 'basic',
  category: 'basic',
  subcategory: 'basic',
  description: 'basic',
  shortDescription: 'basic',
  price: 'pricing',
  priceOnEnquiry: 'pricing',
  originalPrice: 'pricing',
  discount: 'pricing',
  material: 'product',
  color: 'product',
  availableColors: 'product',
  dimensions: 'product',
  size: 'product',
  variants: 'product',
  customization: 'product',
  deliveryInformation: 'product',
  stockStatus: 'inventory',
  madeToOrder: 'inventory',
  featured: 'marketing',
  trending: 'marketing',
  bestSeller: 'marketing',
  newArrival: 'marketing',
  tags: 'marketing',
  relatedProductIds: 'marketing',
  seoTitle: 'seo',
  seoDescription: 'seo',
  keywords: 'seo',
  images: 'images',
  primaryImage: 'images',
};

export function groupFor(path: string): string {
  const root = path.split('.')[0] ?? path;
  return FIELD_GROUPS[root] ?? 'basic';
}
