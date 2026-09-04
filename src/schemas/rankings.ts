/**
 * Manual ranking schema.
 *
 * These three arrays are the operator's ordering, and the *only* basis the
 * Best Selling sort can ever have: the site records no transactions, so a
 * best-seller number would be fabricated. Trending and Most Viewed prefer the
 * measured analytics snapshot and fall back to these arrays, labelled `curated`
 * in the UI (requirements 3.13, 3.15, 3.16).
 *
 * Entries are product slugs. A slug that no longer resolves is ignored by the
 * ranking reader rather than failing the build, because unpublishing a product
 * must not break the homepage.
 *
 * Design: Catalogue → Sorting, with honest fallbacks.
 * Requirements: 3.13, 3.15, 3.16, 20.x (honest reporting).
 */

import { z } from 'zod';

const slugList = z
  .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
  .max(200)
  .default([]);

export const RankingsSchema = z
  .object({
    trending: slugList,
    bestSeller: slugList,
    mostViewed: slugList,
  })
  .passthrough();

export type Rankings = z.infer<typeof RankingsSchema>;
