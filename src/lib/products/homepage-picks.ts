/**
 * Which products each homepage product section shows.
 *
 * Four rules, and the fourth is the one that matters most:
 *
 * 1. **Qualification is the product's own flag.** Featured shows `featured`, new arrivals shows
 *    `newArrival`, and so on. The operator sets the flag in the product editor; nothing here
 *    guesses.
 * 2. **The curated order wins where the operator supplied one.** `data/site/rankings.json` holds
 *    the operator's slug order for best sellers and trending, and a product named there sorts ahead
 *    of one that is not, in the order they named it. This is the same list the Best Selling sort
 *    reads, so the homepage and the catalogue cannot disagree about what "best selling" means.
 * 3. **Everything unranked falls back to newest first, then slug** — a total order, so two builds of
 *    the same catalogue produce the same homepage.
 * 4. **No section ever borrows from another.** Requirement 7.9 forbids substituting products drawn
 *    from another of the four sections when one resolves to zero, so these functions return `[]` and
 *    the section omits itself. There is deliberately no "if empty, show something" branch anywhere
 *    in this module — that branch is the requirement's failure mode, not its fallback.
 *
 * Requirements: 7.2, 7.9, 3.13, 3.15.
 */

import type { ProductSectionComposition } from '@/lib/site/homepage-sections';
import type { Product } from '@/schemas/product';

export interface RankingLists {
  trending: readonly string[];
  bestSeller: readonly string[];
  mostViewed: readonly string[];
}

/** The curated list that applies to a section, or an empty list where none does. */
function curatedFor(
  composition: ProductSectionComposition,
  rankings: RankingLists,
): readonly string[] {
  switch (composition.flag) {
    case 'bestSeller':
      return rankings.bestSeller;
    case 'trending':
      return rankings.trending;
    default:
      return [];
  }
}

export function productsForSection(
  products: readonly Product[],
  composition: ProductSectionComposition,
  rankings: RankingLists,
): Product[] {
  const curated = curatedFor(composition, rankings);
  const rank = new Map(curated.map((slug, index) => [slug, index]));

  return products
    .filter((product) => product[composition.flag])
    .sort((a, b) => {
      // `Infinity` for an unranked product puts it after every ranked one without a branch.
      const left = rank.get(a.slug) ?? Number.POSITIVE_INFINITY;
      const right = rank.get(b.slug) ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left < right ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug);
    })
    .slice(0, composition.limit);
}
