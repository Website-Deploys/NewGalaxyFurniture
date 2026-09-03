/**
 * The public enquiry payload.
 *
 * This is the only schema in the codebase that validates input from an anonymous visitor,
 * and its shape is arranged around three facts about that:
 *
 * 1. **Bounds come from Requirement 6.3, not from the design's sketch.** The design's
 *    `LeadSchema` block writes `message: min(3).max(2000)` and `budget: max(60)`; the
 *    acceptance criterion is stricter and more specific — a message of 10 to 1000
 *    characters, at most 500 in `requirement`, at most 100 in `budget`, at most 200 in
 *    `dimensions`. Where the two disagree the criterion wins, because it is the testable
 *    statement. The design's `source` field is absent for a related reason: the originating
 *    page path is derived on the server from the `Referer` and the submitting URL, so there
 *    is no browser-supplied field for it to arrive in (Requirement 6.7).
 * 2. **Nothing about a product is accepted except its slug.** No `productName`, no `sku`,
 *    no `productUrl`. `.strict()` means a request carrying them is rejected outright rather
 *    than quietly ignoring them, which is the difference between "we do not trust the
 *    browser's product claims" and "we happen not to read them" (Requirement 6.6).
 * 3. **The traps are fields, and they are checked before this schema runs.** `honeypot`
 *    and `renderedAt` are declared here so the shape is closed, but the endpoint evaluates
 *    them first and answers with one generic sentence, because a field-level error would
 *    tell a bot which trap it hit (Requirement 6.8). That is why `honeypot` is a plain
 *    optional string here and not `z.literal('')`: if it reached Zod as a literal mismatch
 *    the failure would arrive keyed to `honeypot`, and the response would name the trap.
 *
 * Every message is written to be rendered under its own control, in the second person, and
 * to say what to do rather than what went wrong.
 *
 * Design: Conversion → Lead capture.
 * Requirements: 6.2, 6.3, 6.4, 6.5, 6.6.
 */

import { z } from 'zod';

import { isE164, normalizeIndianPhone } from '@/lib/phone';
import { LEAD_TYPES } from '@/lib/leads/store';

/** The five forms, as the stored `type` column's values. */
export const LeadTypeSchema = z.enum(LEAD_TYPES);
export type LeadTypeValue = z.infer<typeof LeadTypeSchema>;

/** Requirement 6.3's bounds, in one place so the forms and the server agree. */
export const LEAD_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  messageMin: 10,
  messageMax: 1000,
  requirementMax: 500,
  budgetMax: 100,
  dimensionsMax: 200,
} as const;

/** The minimum age of a rendered form before a submission is credible (6.8). */
export const MIN_FORM_AGE_MS = 1500;

/**
 * A trimmed, optional free-text field.
 *
 * An empty string collapses to `undefined` rather than being stored as `''`: "the visitor
 * left this blank" and "the visitor typed nothing into it" are the same fact, and storing
 * one of them as an empty string makes a lead's optional fields render as empty rows in the
 * admin instead of being omitted.
 */
function optionalText(max: number, label: string) {
  return z
    .string()
    .max(max, `${label} can be at most ${String(max)} characters.`)
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

export const LeadSchema = z
  .object({
    type: LeadTypeSchema,
    name: z
      .string()
      .transform((value) => value.trim())
      .refine(
        (value) => value.length >= LEAD_LIMITS.nameMin,
        `Enter your name — at least ${String(LEAD_LIMITS.nameMin)} characters.`,
      )
      .refine(
        (value) => value.length <= LEAD_LIMITS.nameMax,
        `Your name can be at most ${String(LEAD_LIMITS.nameMax)} characters.`,
      ),
    /**
     * Normalised in the schema, so nothing downstream ever sees an unnormalised number.
     * The transform cannot fail — `normalizeIndianPhone` never throws — so the failure is
     * expressed as a refinement on its output, which is what puts the human message on the
     * `phone` path (Requirement 6.5).
     */
    phone: z
      .string()
      .transform((value, ctx) => {
        const result = normalizeIndianPhone(value);
        if (!result.ok) {
          // The library's own sentence, which already names every accepted form.
          ctx.addIssue({ code: 'custom', message: result.message });
          return z.NEVER;
        }
        return result.e164;
      })
      .refine(isE164, 'Enter a valid Indian mobile number.'),
    message: z
      .string()
      .transform((value) => value.trim())
      .refine(
        (value) => value.length >= LEAD_LIMITS.messageMin,
        `Tell us a little more — at least ${String(LEAD_LIMITS.messageMin)} characters.`,
      )
      .refine(
        (value) => value.length <= LEAD_LIMITS.messageMax,
        `Please keep this under ${String(LEAD_LIMITS.messageMax)} characters.`,
      ),
    /**
     * The product reference. A slug and nothing else, and the server resolves it.
     *
     * Shape-checked against the slug charset here so an obviously malformed reference is a
     * field error rather than a database lookup. Whether it *exists* is a separate question
     * answered by `resolveProductReference`, because "not a slug" and "no longer available"
     * are different messages with different recoveries (6.17).
     */
    productSlug: z
      .string()
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'That product reference is not valid.')
      .optional(),
    requirement: optionalText(LEAD_LIMITS.requirementMax, 'The requirement'),
    budget: optionalText(LEAD_LIMITS.budgetMax, 'The approximate budget'),
    dimensions: optionalText(LEAD_LIMITS.dimensionsMax, 'The dimensions'),
    /** Must be empty. Evaluated by the endpoint before this schema; see the header. */
    honeypot: z.string().max(200).optional(),
    /** Epoch ms the form was rendered, from the browser clock. Advisory by nature. */
    renderedAt: z.number().finite(),
  })
  .strict()
  /**
   * Requirement 6.3: Quick Enquire additionally requires a product reference.
   *
   * Enforced here rather than by a separate schema per form so there is exactly one payload
   * contract. A per-form schema would be five places for the name bound to drift.
   */
  .superRefine((lead, ctx) => {
    if (lead.type === 'QUICK_ENQUIRE' && lead.productSlug === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['productSlug'],
        message: 'This enquiry has lost its product reference. Reopen it from the product.',
      });
    }
  });

export type LeadInput = z.infer<typeof LeadSchema>;

/**
 * Field-keyed errors, in the shape `readValidatedJson` produces for admin routes.
 *
 * Public forms render errors inline exactly as admin forms do, so both sources have to
 * arrive in one shape. Duplicated messages on one path are collapsed: two refinements can
 * legitimately produce the same sentence, and showing it twice under one input reads as a
 * bug.
 */
export function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const problem of error.issues) {
    const key = problem.path.length > 0 ? problem.path.join('.') : '_';
    const bucket = fields[key];
    if (bucket === undefined) fields[key] = [problem.message];
    else if (!bucket.includes(problem.message)) bucket.push(problem.message);
  }
  return fields;
}
