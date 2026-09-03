/**
 * What an admin request may say about a review, and how a stored review is derived from it.
 *
 * The whole point of this module is that **nothing here can invent a review**. There is no
 * default customer name, no default rating, no template text, and no code path that fills
 * any of them in (Requirement 18.9). Every field either comes from the operator or stays
 * absent. A review is created as `DRAFT` and only an explicit publish makes it visible
 * (Requirement 18.8) — the same shape as the product lifecycle, and for the same reason:
 * publication is an act, not a side effect of saving.
 *
 * The id is generated server-side as `rev_` + 10 base36 characters, which is exactly what
 * the path allowlist admits (`data/reviews/rev_[a-z0-9]{10}.json`). A client-supplied id
 * therefore has no way into a filename.
 *
 * **A note on review media.** `ReviewSchema` carries `customerPhotoKey`, `productPhotoKey`
 * and `videoKey` — R2 object *keys*. The design declares no upload endpoint for review
 * media and `/img/**` resolves only `products/{p_…}/{img_…}` keys, so there is currently no
 * way to put an object at one of these keys or to serve it. The fields are therefore stored
 * faithfully and the admin UI says plainly that they cannot be uploaded yet, rather than
 * offering a control that would silently do nothing.
 *
 * Design: Data Models → Other collections.
 * Requirements: 18.6, 18.7, 18.8, 18.9.
 */

import { z } from 'zod';

import { ReviewSchema, ReviewStatus, type Review } from '@/schemas/review';

/** `rev_` + 10 base36 characters — the shape `ALLOWED_PATTERNS` admits. */
export function generateReviewId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (const byte of bytes) suffix += chars[byte % chars.length];
  return `rev_${suffix}`;
}

export const REVIEW_ID = /^rev_[a-z0-9]{10}$/;

/* -------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bounds mirror `ReviewSchema` exactly. `status` is absent: it moves through
 * `PATCH { status }` on its own, which is what keeps "published" an explicit act.
 */
const EditableReviewFields = z.object({
  customerName: z.string().min(1).max(80),
  rating: z.number().int().min(1).max(5),
  text: z.string().min(5).max(1500),
  customerPhotoKey: z.string().max(300).nullable(),
  productPhotoKey: z.string().max(300).nullable(),
  videoKey: z.string().max(300).nullable(),
  productId: z.string().max(60).nullable(),
  /** `YYYY-MM-DD`, the date the customer gave the review — never today by default. */
  date: z.string().date().nullable(),
  featured: z.boolean(),
});

export const ReviewCreateInput = EditableReviewFields.extend({
  customerName: z.string().min(1).max(80),
  rating: z.number().int().min(1).max(5),
  text: z.string().min(5).max(1500),
})
  .partial({
    customerPhotoKey: true,
    productPhotoKey: true,
    videoKey: true,
    productId: true,
    date: true,
    featured: true,
  })
  .strict();

export const ReviewPatchInput = z
  .object({
    patch: EditableReviewFields.partial().strict(),
    /** Publish, unpublish, or return to draft. Explicit, never derived from an edit. */
    status: ReviewStatus.optional(),
  })
  .strict();

export const ReviewReorderInput = z
  .object({ order: z.array(z.string().regex(REVIEW_ID)).min(1).max(400) })
  .strict();

export const ReviewDeleteInput = z.object({ confirmId: z.string().min(1) }).strict();

export type ReviewCreateInputValue = z.infer<typeof ReviewCreateInput>;
export type ReviewPatchInputValue = z.infer<typeof ReviewPatchInput>;
export type EditableReviewValues = z.infer<typeof EditableReviewFields>;

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

export type FieldErrors = Record<string, string[]>;

export function validateReview(
  candidate: unknown,
): { ok: true; review: Review } | { ok: false; fields: FieldErrors } {
  const parsed = ReviewSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, review: parsed.data };
  const fields: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [issue.message];
    else if (!bucket.includes(issue.message)) bucket.push(issue.message);
  }
  return { ok: false, fields };
}

const OPTIONAL_KEYS = [
  'customerPhotoKey',
  'productPhotoKey',
  'videoKey',
  'productId',
  'date',
] as const;
const PLAIN_KEYS = ['customerName', 'rating', 'text', 'featured'] as const;

/** A new review: always `DRAFT`, ordered last, nothing pre-filled. */
export function buildNewReview(
  input: ReviewCreateInputValue,
  existing: readonly Review[],
): Record<string, unknown> {
  const maxOrder = existing.reduce((highest, review) => Math.max(highest, review.order), -1);
  const record: Record<string, unknown> = {
    id: generateReviewId(),
    customerName: input.customerName,
    rating: input.rating,
    text: input.text,
    // Not `PUBLISHED`, and not configurable at create: Requirement 18.8 requires an
    // operator to publish, and a create flag would be a way to skip that decision.
    status: 'DRAFT',
    featured: input.featured ?? false,
    order: maxOrder + 1,
  };
  const raw = input as unknown as Record<string, unknown>;
  for (const key of OPTIONAL_KEYS) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') record[key] = value;
  }
  return record;
}

export function applyReviewPatch(
  current: Review,
  patch: Partial<EditableReviewValues>,
  status?: Review['status'],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const raw = patch as Record<string, unknown>;

  for (const key of PLAIN_KEYS) {
    if (key in raw && raw[key] !== undefined && raw[key] !== null) next[key] = raw[key];
  }
  for (const key of OPTIONAL_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  if (status !== undefined) next.status = status;
  return next;
}

/** The ordering, renumbered contiguously; unmentioned reviews keep their relative order. */
export function reorderReviews(
  existing: readonly Review[],
  requested: readonly string[],
): { id: string; order: number }[] {
  const known = new Map(existing.map((review) => [review.id, review]));
  const ordered: string[] = [];
  for (const id of requested) {
    if (known.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  const remaining = [...known.values()]
    .filter((review) => !ordered.includes(review.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((review) => review.id);

  return [...ordered, ...remaining].map((id, index) => ({ id, order: index }));
}

/**
 * `true` when this write cannot change what a visitor sees.
 *
 * A review that is a draft now and was a draft before is invisible either way, so the
 * commit carries `[skip ci]` and does not spend a build (Requirement 17.14). Anything
 * touching a published review — including unpublishing one — rebuilds.
 */
export function reviewWriteSkipsCi(from: Review['status'] | null, to: Review['status']): boolean {
  const publicNow = to === 'PUBLISHED';
  const publicBefore = from === 'PUBLISHED';
  return !publicNow && !publicBefore;
}
