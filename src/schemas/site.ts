/**
 * Site settings schema — every piece of business information the site displays.
 *
 * Three shapes here are load-bearing rather than incidental:
 *
 * - `whatsapp` and `phone` are **arrays** from day one. That is the whole of the
 *   "more numbers later" flexibility requirement (19.2): an extra number is a new
 *   array element, not a schema change. Both supplied numbers appear in both
 *   arrays with neutral labels — never as different departments (5.10, 19.3).
 * - `logo.src` is nullable with a mandatory `wordmarkFallback`. No brand asset
 *   exists yet, so the site renders the typographic wordmark until a file is
 *   dropped in and this one field is set (19.4, 19.5).
 * - Every unknown location, social, and SEO value is `null` rather than a guess.
 *   Surfaces omit null values instead of displaying an invented one (19.6).
 *
 * Design: Data Models → Other collections.
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 8.8.
 */

import { z } from 'zod';

/** E.164: `+`, a non-zero country digit, then 7–14 more digits. */
export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const ContactNumber = z.object({ label: z.string(), e164: E164 });

export const SiteSettingsSchema = z
  .object({
    businessName: z.string(),
    /**
     * `width`/`height` are the asset's intrinsic pixel dimensions, and they are required whenever
     * `src` is set — see the refinement below. Every `<img>` on this site carries intrinsic
     * dimensions so its box is reserved before a byte arrives, and the brand mark is the one image
     * whose dimensions cannot come from the product schema. Nullable rather than optional so the
     * settings file states "not supplied" the same way every other unsupplied field does.
     */
    logo: z.object({
      src: z.string().nullable(),
      wordmarkFallback: z.string(),
      width: z.number().int().positive().nullable().default(null),
      height: z.number().int().positive().nullable().default(null),
    }),
    whatsapp: z.array(ContactNumber).min(1),
    phone: z.array(ContactNumber).min(1),
    location: z.object({
      addressLines: z.array(z.string()),
      city: z.string(),
      state: z.string(),
      postalCode: z.string().nullable(),
      mapUrl: z.string().url().nullable(),
      geo: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    }),
    serviceArea: z.array(z.string()).default(['Karnataka']),
    social: z.record(z.string(), z.string().url().nullable()).default({}),
    seoDefaults: z.object({
      titleSuffix: z.string(),
      description: z.string(),
      ogImageKey: z.string().nullable(),
    }),
    placeholders: z.array(z.string()).default([]), // content keys still awaiting real copy
  })
  .passthrough()
  /**
   * A brand mark cannot be supplied without its intrinsic box.
   *
   * The rule the design states for images is "explicit intrinsic dimensions on every image", and a
   * logo whose dimensions are unknown is a header that shifts sideways when it loads — on every
   * page, above the fold. Enforcing it here means the failure is the designed one: the content gate
   * names the file and the field before deploy, and the Settings form shows a field-level message,
   * rather than the site quietly emitting a `<img>` with no box.
   */
  .superRefine((value, ctx) => {
    if (value.logo.src === null) return;
    for (const key of ['width', 'height'] as const) {
      if (value.logo[key] === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['logo', key],
          message: `Required when a brand mark path is set: the ${key} in pixels of ${value.logo.src}, so its box is reserved before it loads.`,
        });
      }
    }
  });

export type SiteSettings = z.infer<typeof SiteSettingsSchema>;
export type ContactNumberValue = z.infer<typeof ContactNumber>;

/**
 * Slug → target path map written by the rename path in the write pipeline and
 * turned into 301s at build time. Empty until the first rename.
 */
export const RedirectsSchema = z.record(z.string(), z.string());

export type Redirects = z.infer<typeof RedirectsSchema>;
