/**
 * Category schema.
 *
 * A category is a file: dropping `data/categories/{slug}.json` in gives the site a
 * listing route, a navigation entry, and a filter option after the next deploy
 * with no code change (requirement 18.3). `illustration` is an enum rather than an
 * image key because the nine seeded categories are drawn as SVG illustrations —
 * there is no category photography, and none is invented.
 *
 * Design: Data Models → Other collections.
 * Requirements: 18.1, 18.5, 18.7.
 */

import { z } from 'zod';

export const CategoryIllustration = z.enum([
  'sofa',
  'bed',
  'diningTable',
  'diningChair',
  'accentChair',
  'coffeeTable',
  'storage',
  'office',
  'outdoor',
]);

export const CategorySchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(), // "Sofas & Sectionals"
    shortDescription: z.string().max(200),
    /**
     * The category page's location paragraph (Requirement 23.17).
     *
     * Separate from `shortDescription`, which is the one-line summary used in navigation and
     * cards: this is prose that appears on the listing page only, and it exists so the location
     * signal is carried by genuine content — where the pieces are made, where they are delivered —
     * rather than by keyword repetition. Optional, because a category with nothing true to add
     * should add nothing.
     */
    intro: z.string().max(600).optional(),
    order: z.number().int(),
    illustration: CategoryIllustration,
    heroImageKey: z.string().optional(),
    subcategories: z.array(z.object({ slug: z.string(), name: z.string() })).default([]),
    seoTitle: z.string().max(70).optional(),
    seoDescription: z.string().max(170).optional(),
    published: z.boolean().default(true),
  })
  .passthrough();

export type Category = z.infer<typeof CategorySchema>;
export type CategoryIllustrationValue = z.infer<typeof CategoryIllustration>;

/** The nine categories seeded on first deployment (requirement 18.1). */
export const SEEDED_CATEGORY_SLUGS = [
  'sofas',
  'beds',
  'dining-tables',
  'dining-chairs',
  'accent-chairs',
  'coffee-side-tables',
  'storage-display',
  'office',
  'outdoor',
] as const;
