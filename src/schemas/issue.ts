/**
 * Shared refinement helpers.
 *
 * Every cross-field failure in this codebase is reported *against the field that
 * failed*, because the admin UI renders errors inline next to their control and
 * requirement 17.8 requires a field-level report. A bare `ctx.addIssue({ message })`
 * with no `path` lands on the object root and the UI has nowhere to draw it, so
 * these three helpers are the only sanctioned way to raise a refinement issue.
 *
 * Design: Data Models → Cross-field invariants, Publish gate.
 * Requirements: 14.4, 14.5, 17.8, 17.9.
 */

import type { z } from 'zod';

/** A Zod issue path: object keys and array indices, outermost first. */
export type FieldPath = readonly (string | number)[];

/** Raise a custom issue against a specific field path. */
export function issue(ctx: z.RefinementCtx, path: string | FieldPath, message: string): void {
  ctx.addIssue({
    code: 'custom',
    message,
    path: typeof path === 'string' ? [path] : [...path],
  });
}

/**
 * The value must be present and contain at least one non-whitespace character.
 * Used by the publish gate, where "present but blank" is the common near-miss.
 */
export function requireNonEmpty(
  ctx: z.RefinementCtx,
  value: string | null | undefined,
  field: string,
): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    issue(ctx, field, `${field} is required before publishing`);
  }
}

/** The value must be present and at least `min` characters long after trimming. */
export function requireMinLength(
  ctx: z.RefinementCtx,
  value: string | null | undefined,
  min: number,
  field: string,
): void {
  if (value === null || value === undefined || value.trim().length < min) {
    issue(ctx, field, `${field} must be at least ${min} characters before publishing`);
  }
}
