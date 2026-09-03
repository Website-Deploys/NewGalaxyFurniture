import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import MiniSearch from 'minisearch';

import { buildIndex, rankedSlugs, suggest } from '@/lib/search/query';
import type { SuggestContext } from '@/lib/search/query';
import type { SearchDoc } from '@/lib/search/types';

import { distinctSearchDocsArb } from './arbitraries';
import { assertProperty } from './config';

/**
 * Search ranking.
 *
 * Design: Catalogue → Matching.
 */

const CATEGORY_NAMES: Record<string, string> = {
  sofas: 'Sofas & Sectionals',
  beds: 'Beds',
  'dining-tables': 'Dining Tables',
  'dining-chairs': 'Dining Chairs',
  'accent-chairs': 'Accent Chairs',
  'coffee-side-tables': 'Coffee & Side Tables',
  'storage-display': 'Storage & Display',
  office: 'Office',
  outdoor: 'Outdoor',
};

function contextFor(docs: readonly SearchDoc[]): SuggestContext {
  return { docs, index: buildIndex(MiniSearch, docs), categoryNames: CATEGORY_NAMES };
}

describe('Property 39: Exact SKU search ranks its product first', () => {
  it('returns the product bearing the SKU first, in any letter case', () => {
    assertProperty(
      fc.property(
        distinctSearchDocsArb({ minLength: 1, maxLength: 12 }),
        fc.nat(),
        (docs, pick) => {
          const target = docs[pick % docs.length];
          expect(target).toBeDefined();
          if (target === undefined) return;

          const context = contextFor(docs);

          // Requirement 2.5: "a complete SKU in any letter case".
          for (const query of [
            target.k,
            target.k.toLowerCase(),
            target.k.toUpperCase(),
            `  ${target.k}  `,
          ]) {
            const ranked = rankedSlugs(query, context);
            expect(ranked[0]).toBe(target.i);

            // And it is the first *suggestion*, not merely the first internal match.
            const suggestions = suggest(query, context);
            expect(suggestions[0]?.href).toBe(`/product/${target.i}`);
          }
        },
      ),
    );
  });

  it('never returns more than eight suggestions, ordered products then categories then filters', () => {
    assertProperty(
      fc.property(
        distinctSearchDocsArb({ minLength: 1, maxLength: 14 }),
        fc.nat(),
        (docs, pick) => {
          const target = docs[pick % docs.length];
          if (target === undefined) return;
          const suggestions = suggest(target.k, contextFor(docs));

          expect(suggestions.length).toBeLessThanOrEqual(8);

          const rank = { product: 0, category: 1, filter: 2 } as const;
          const ranks = suggestions.map((suggestion) => rank[suggestion.kind]);
          for (let index = 1; index < ranks.length; index += 1) {
            expect(ranks[index - 1] ?? 0).toBeLessThanOrEqual(ranks[index] ?? 0);
          }
        },
      ),
    );
  });
});
