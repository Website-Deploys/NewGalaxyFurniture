/**
 * What an admin request may say about a category, and how a stored category is derived
 * from it.
 *
 * The same discipline as products: the endpoint accepts a narrow input, the server builds
 * the record, and identity is not client-writable. A category's `slug` is its filename and
 * its public URL (`/collection/{slug}`), so it is set once at creation from the name and is
 * never patchable — there is no rename-with-redirect path for categories, and inventing one
 * silently would break every link into a listing.
 *
 * The interesting rule here is the delete guard. Requirement 18.4 refuses the deletion of a
 * category products are assigned to and asks for the *number* assigned. The count comes
 * from the KV product index — a projection of committed product files — and it counts
 * products in **every** status, not just published ones: a draft assigned to a deleted
 * category would fail `validate:content` at the next build (Requirement 18.5), which is a
 * broken build rather than a tidy catalogue.
 *
 * Design: Data Models → Other collections; Write Pipeline → Path allowlist.
 * Requirements: 18.2, 18.3, 18.4, 18.5.
 */

import { z } from 'zod';

import { CategoryIllustration, CategorySchema, type Category } from '@/schemas/category';
import { toSlug, uniqueSlug } from '@/lib/slug';
import type { ProductSummary } from '@/lib/products/index-store';

/* -------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* -------------------------------------------------------------------------- */

const EditableCategoryFields = z.object({
  name: z.string().min(1).max(80),
  shortDescription: z.string().max(200),
  illustration: CategoryIllustration,
  subcategories: z.array(z.object({ slug: z.string().min(1), name: z.string().min(1) })).max(24),
  seoTitle: z.string().max(70).nullable(),
  seoDescription: z.string().max(170).nullable(),
  published: z.boolean(),
});

/**
 * Create needs a name and an illustration. `slug` and `order` are server-derived: the slug
 * from the name, the order as "after every existing category", which is where a newly
 * created thing belongs.
 */
export const CategoryCreateInput = EditableCategoryFields.partial()
  .extend({
    name: z.string().min(1).max(80),
    illustration: CategoryIllustration,
  })
  .strict();

/** `order` is absent: reordering is its own atomic operation, not a per-record edit. */
export const CategoryPatchInput = z
  .object({ patch: EditableCategoryFields.partial().strict() })
  .strict();

/** The whole ordering, as one list of slugs. Applied as a single commit. */
export const CategoryReorderInput = z
  .object({ order: z.array(z.string().min(1)).min(1).max(200) })
  .strict();

/** Deleting a category names it, for the same reason deleting a product names its slug. */
export const CategoryDeleteInput = z.object({ confirmSlug: z.string().min(1) }).strict();

export type CategoryCreateInputValue = z.infer<typeof CategoryCreateInput>;
export type CategoryPatchInputValue = z.infer<typeof CategoryPatchInput>;

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

export type FieldErrors = Record<string, string[]>;

export function validateCategory(
  candidate: unknown,
): { ok: true; category: Category } | { ok: false; fields: FieldErrors } {
  const parsed = CategorySchema.safeParse(candidate);
  if (parsed.success) return { ok: true, category: parsed.data };
  const fields: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [issue.message];
    else if (!bucket.includes(issue.message)) bucket.push(issue.message);
  }
  return { ok: false, fields };
}

/** A new category, ordered last, published unless the request says otherwise. */
export function buildNewCategory(
  input: CategoryCreateInputValue,
  existing: readonly Category[],
): Record<string, unknown> {
  const taken = new Set(existing.map((category) => category.slug));
  const maxOrder = existing.reduce((highest, category) => Math.max(highest, category.order), -1);

  return {
    slug: uniqueSlug(input.name, taken),
    name: input.name,
    // Empty rather than a generated sentence: a category blurb is operator copy, and the
    // admin list flags an empty one. Nothing about the category is invented here.
    shortDescription: input.shortDescription ?? '',
    order: maxOrder + 1,
    illustration: input.illustration,
    subcategories: input.subcategories ?? [],
    ...(input.seoTitle === undefined || input.seoTitle === null
      ? {}
      : { seoTitle: input.seoTitle }),
    ...(input.seoDescription === undefined || input.seoDescription === null
      ? {}
      : { seoDescription: input.seoDescription }),
    published: input.published ?? true,
  };
}

/** Keys the schema declares `optional()`; `null` from the form clears them. */
const OPTIONAL_KEYS = ['seoTitle', 'seoDescription'] as const;
const PLAIN_KEYS = ['name', 'shortDescription', 'illustration', 'subcategories', 'published'];

export function applyCategoryPatch(
  current: Category,
  patch: Partial<z.infer<typeof EditableCategoryFields>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const raw = patch as Record<string, unknown>;

  for (const key of PLAIN_KEYS) {
    if (key in raw && raw[key] !== undefined && raw[key] !== null) next[key] = raw[key];
  }
  for (const key of OPTIONAL_KEYS) {
    if (!(key in raw)) continue;
    if (raw[key] === null || raw[key] === undefined) delete next[key];
    else next[key] = raw[key];
  }
  return next;
}

/**
 * The ordering, renumbered contiguously from 0.
 *
 * Contiguity is not required by `CategorySchema` — `order` is any integer — but producing
 * it means two categories can never claim the same position, which the sort in
 * `filterCategories` would then break ties on arbitrarily. Slugs the request does not
 * mention keep their relative order and follow the ones it does, so a stale client that
 * omits a category created in another tab cannot delete it from the ordering.
 */
export function reorderCategories(
  existing: readonly Category[],
  requested: readonly string[],
): { slug: string; order: number }[] {
  const known = new Map(existing.map((category) => [category.slug, category]));
  const ordered: string[] = [];
  for (const slug of requested) {
    if (known.has(slug) && !ordered.includes(slug)) ordered.push(slug);
  }
  const remaining = [...known.values()]
    .filter((category) => !ordered.includes(category.slug))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
    .map((category) => category.slug);

  return [...ordered, ...remaining].map((slug, index) => ({ slug, order: index }));
}

/* -------------------------------------------------------------------------- */
/* The delete guard                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How many products are assigned to a category (Requirement 18.4).
 *
 * Every status counts — see the file header for why a draft matters here.
 */
export function assignedProductCount(
  summaries: readonly ProductSummary[],
  slug: string,
): { total: number; published: number } {
  let total = 0;
  let published = 0;
  for (const summary of summaries) {
    if (summary.category !== slug) continue;
    total += 1;
    if (summary.status === 'PUBLISHED' || summary.status === 'OUT_OF_STOCK') published += 1;
  }
  return { total, published };
}

export function assignedProductsMessage(count: { total: number; published: number }): string {
  const noun = count.total === 1 ? 'product is' : 'products are';
  const live =
    count.published === 0
      ? ''
      : ` ${String(count.published)} of them ${count.published === 1 ? 'is' : 'are'} live on the site.`;
  return (
    `${String(count.total)} ${noun} still assigned to this category, so it cannot be deleted.` +
    `${live} Move them to another category first.`
  );
}

/** The slug a category with this name would take — shown in the create form. */
export function previewCategorySlug(name: string): string {
  return toSlug(name);
}
