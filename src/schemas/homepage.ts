/**
 * Homepage composition schema.
 *
 * The homepage is fifteen sections in a fixed relative order (requirement 7.1).
 * The operator controls which sections render and what they say; the operator does
 * not control the order, because the order is a design decision the requirement
 * pins down. The refinement therefore allows omission but rejects reordering and
 * duplication — a reordered `homepage.json` fails `validate:content` rather than
 * quietly shipping a homepage that violates 7.1.
 *
 * Copy fields are all optional. A section with no supplied copy renders its
 * `[PLACEHOLDER — …]` marker, visually distinguished and listed in the admin
 * content checklist (requirement 7.10); no manufacturing process, timeline,
 * capability, or achievement is ever invented here.
 *
 * Design: Pages, Navigation, and States → Homepage composition.
 * Requirements: 7.1, 7.7, 7.8, 7.10, 7.13, 8.8.
 */

import { z } from 'zod';

import { issue } from './issue';

/** The fifteen sections, in the required order. Index in this array *is* the order. */
export const HOMEPAGE_SECTION_KEYS = [
  'hero',
  'shopByCategory',
  'featuredProducts',
  'newArrivals',
  'bestSellers',
  'trending',
  'craftsmanship',
  'directManufacturer',
  'customFurniture',
  'workshopStory',
  'customerReviews',
  'gallery',
  'whatsappCta',
  'contactLocation',
  'footer',
] as const;

export const HomepageSectionKey = z.enum(HOMEPAGE_SECTION_KEYS);

/**
 * An editorial photograph supplied for a section.
 *
 * This is a genuine, operator-supplied asset, so it is not placeholder-gated the way copy is: a
 * section with no `image` keeps its existing hairline illustration, and one with an image paints the
 * photograph. `base` is a same-origin path under `/brand/` and `widths` are the responsive
 * derivatives that actually exist on disk — the component builds the `srcset` from exactly these, so
 * it can never reference a width that was never generated. `caption` is the optional script-lettered
 * line the reference overlays on the photo ("Details make better homes"); it carries no business
 * claim, so it is free of the placeholder discipline that governs `body`.
 *
 * Requirements: 7.7, 7.10, 22.10.
 */
export const HomepageSectionImageSchema = z.object({
  /** Same-origin base path, e.g. `/brand/home-craft`. Derivatives are `${base}-${width}.webp`. */
  base: z.string().min(1).max(200),
  /** Intrinsic dimensions of the largest derivative, so the box is reserved against CLS. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The responsive widths that exist on disk. The srcset is built from exactly these. */
  widths: z.array(z.number().int().positive()).min(1),
  /** Required alt text — a photograph with no alt is an accessibility defect, not an option. */
  alt: z.string().min(1).max(240),
  /** Optional script-lettered overlay line. No business claim; free of placeholder discipline. */
  caption: z.string().max(120).optional(),
});

export const HomepageSectionSchema = z
  .object({
    key: HomepageSectionKey,
    enabled: z.boolean(),
    /** The hero's positioning line. Operator-editable, 1–120 chars (requirement 7.8). */
    tagline: z.string().min(1).max(120).optional(),
    eyebrow: z.string().max(60).optional(),
    heading: z.string().max(120).optional(),
    subheading: z.string().max(240).optional(),
    body: z.string().max(2000).optional(),
    ctaLabel: z.string().max(40).optional(),
    ctaHref: z.string().max(200).optional(),
    /** An editorial photograph for the section's panel, where the operator has supplied one. */
    image: HomepageSectionImageSchema.optional(),
    /** A second, smaller photograph — used by the custom-furniture band's detail image. */
    secondaryImage: HomepageSectionImageSchema.optional(),
    /** True while `body` still holds a `[PLACEHOLDER — …]` marker awaiting real copy. */
    awaitingCopy: z.boolean().default(false),
  })
  .passthrough();

export const HomepageSchema = z
  .object({
    sections: z.array(HomepageSectionSchema).min(1),
  })
  .passthrough()
  .superRefine((page, ctx) => {
    const seen = new Set<string>();
    let lastRank = -1;

    page.sections.forEach((section, index) => {
      if (seen.has(section.key)) {
        issue(ctx, ['sections', index, 'key'], `Duplicate section "${section.key}"`);
      }
      seen.add(section.key);

      const rank = HOMEPAGE_SECTION_KEYS.indexOf(section.key);
      if (rank < lastRank) {
        issue(
          ctx,
          ['sections', index, 'key'],
          `Section "${section.key}" is out of the required order; ` +
            `sections must keep the order declared in HOMEPAGE_SECTION_KEYS`,
        );
      }
      lastRank = Math.max(lastRank, rank);
    });

    const marked = page.sections.filter((s) => s.awaitingCopy && s.body === undefined);
    for (const section of marked) {
      const index = page.sections.indexOf(section);
      issue(
        ctx,
        ['sections', index, 'body'],
        `Section "${section.key}" is marked as awaiting copy but carries no placeholder body`,
      );
    }
  });

export type HomepageSection = z.infer<typeof HomepageSectionSchema>;
export type HomepageSectionImage = z.infer<typeof HomepageSectionImageSchema>;
export type Homepage = z.infer<typeof HomepageSchema>;
export type HomepageSectionKeyValue = z.infer<typeof HomepageSectionKey>;
