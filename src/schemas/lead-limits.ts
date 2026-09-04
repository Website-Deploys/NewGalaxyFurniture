/**
 * The lead form's bounds — and nothing else.
 *
 * These two constants live apart from `./lead` for one reason: **so the browser does not have to
 * download Zod to render a form.** `EnquiryForm` needs `LEAD_LIMITS` to set each field's `maxLength`
 * and to write "At least 10 characters." into a hint. Importing them from `./lead` pulled that
 * module's `import { z } from 'zod'` into every island that mounts a form — the contact form, the
 * callback form, the custom-furniture form, the quote form on a product page, and the Quick Enquire
 * dialog, which is on the homepage, the catalogue, and all nine category pages.
 *
 * Two costs came with it, and the second is the one that is easy to miss:
 *
 * 1. **62 kB of schema library** in the client bundle of every page that can take an enquiry, to
 *    read seven integers.
 * 2. **A content-security-policy violation on each of those pages.** Zod feature-detects whether the
 *    runtime permits dynamic code by calling `Function('')` inside a `try`. Under this site's policy
 *    — `script-src 'self'` plus four hashes, with no `'unsafe-eval'` — that call is blocked. Zod
 *    handles the exception correctly and nothing breaks, but the browser still fires
 *    `securitypolicyviolation` and, in production, sends a violation report for every visitor on
 *    every one of those pages. A policy that reports a violation on the happy path is a policy
 *    nobody will read the reports of.
 *
 * `./lead` re-exports both names, so the server-side schema code is unchanged and there is still one
 * definition of each bound.
 *
 * Requirements: 6.3, 6.8, 22.1, 25.6.
 * Design: Conversion Surfaces; Security → Content security policy.
 */

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
