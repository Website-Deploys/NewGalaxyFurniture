/**
 * The publish gate.
 *
 * A draft may be saved freely and incompletely — that is the point of a draft.
 * Eligibility for a *public* status (`PUBLISHED` / `OUT_OF_STOCK`) is a strictly
 * stronger condition, expressed as a separate schema layered on the canonical one
 * so the two can never drift: `PublishReadySchema` is `ProductSchema` plus
 * required-field tightening, therefore publish-ready always implies schema-valid.
 *
 * `checkPublishGate` never throws and never returns a Zod error object: the admin
 * UI needs field-keyed messages it can render inline next to each control.
 *
 * Design: Data Models → Publish gate.
 * Requirements: 12.3, 14.4, 14.5.
 */

import { issue, requireMinLength, requireNonEmpty } from './issue';
import { ProductSchema } from './product';

export const PublishReadySchema = ProductSchema.superRefine((p, ctx) => {
  requireNonEmpty(ctx, p.name, 'name');
  requireNonEmpty(ctx, p.category, 'category');
  requireNonEmpty(ctx, p.sku, 'sku');
  requireMinLength(ctx, p.description, 20, 'description');
  if (p.price === null && !p.priceOnEnquiry) {
    issue(ctx, 'price', 'Price or price-on-enquiry required');
  }
  if (p.images.length < 1) issue(ctx, 'images', 'At least one image required');
  if (!p.stockStatus) issue(ctx, 'stockStatus', 'Stock status required');
  if (p.images.some((i) => !i.alt.trim())) issue(ctx, 'images', 'Every image needs alt text');
  // SEO fallbacks are generated, so seoTitle/seoDescription are not hard-required.
});

/** Field path → messages, keyed the way the admin form keys its controls. */
export type PublishGateFailures = Record<string, string[]>;

export type PublishGateResult = { ok: true } | { ok: false; fields: PublishGateFailures };

/**
 * Total function: any input at all, including a partially filled draft or a value
 * that is not a product, yields a result rather than an exception.
 */
export function checkPublishGate(product: unknown): PublishGateResult {
  const parsed = PublishReadySchema.safeParse(product);
  if (parsed.success) return { ok: true };

  const fields: PublishGateFailures = Object.create(null) as PublishGateFailures;
  for (const problem of parsed.error.issues) {
    // An issue with no path belongs to the record as a whole.
    const key = problem.path.length > 0 ? problem.path.join('.') : '_';
    const existing = fields[key];
    if (existing === undefined) {
      fields[key] = [problem.message];
    } else if (!existing.includes(problem.message)) {
      existing.push(problem.message);
    }
  }
  return { ok: false, fields };
}
