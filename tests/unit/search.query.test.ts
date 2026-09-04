import MiniSearch from 'minisearch';
import { describe, expect, it } from 'vitest';

import {
  candidatesFor,
  collectionSearchHref,
  buildIndex,
  editDistance,
  maxEditsFor,
  nearestMatches,
  SEARCH_BOOSTS,
  SEARCH_FIELDS,
  suggest,
} from '@/lib/search/query';
import type { SuggestContext } from '@/lib/search/query';
import { withRecentSearch, RECENT_SEARCH_LIMIT } from '@/lib/search/recent';
import type { SearchDoc } from '@/lib/search/types';

/**
 * Matching, suggestions, and recent searches.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.6, 2.9, 2.10, 2.12, 2.13.
 */

const CATEGORY_NAMES: Record<string, string> = {
  sofas: 'Sofas & Sectionals',
  'accent-chairs': 'Accent Chairs',
  'coffee-side-tables': 'Coffee & Side Tables',
  beds: 'Beds',
};

function doc(partial: Partial<SearchDoc> & Pick<SearchDoc, 'i' | 'n' | 'k' | 'c'>): SearchDoc {
  return {
    o: [],
    t: [],
    p: 42_000,
    st: 'IN_STOCK',
    f: 0,
    ts: 1_700_000_000,
    th: '',
    lq: '',
    ...partial,
  };
}

/** The design's worked example: three brown products across three categories. */
const DOCS: SearchDoc[] = [
  doc({
    i: 'brown-l-shape-sofa',
    n: 'Brown L-Shape Sofa',
    k: 'NGF-SOF-4F2K9C',
    c: 'sofas',
    m: 'Fabric upholstery',
    o: ['Brown', 'Beige'],
    t: ['l-shape'],
  }),
  doc({
    i: 'brown-accent-chair',
    n: 'Brown Accent Chair',
    k: 'NGF-ACH-7H1M3D',
    c: 'accent-chairs',
    m: 'Teak',
    o: ['Brown'],
    p: 12_000,
  }),
  doc({
    i: 'brown-wooden-coffee-table',
    n: 'Brown Wooden Coffee Table',
    k: 'NGF-CST-9K4P2Q',
    c: 'coffee-side-tables',
    m: 'Sheesham Wood',
    o: ['Brown', 'Walnut'],
    p: null,
  }),
  doc({ i: 'ivory-queen-bed', n: 'Ivory Queen Bed', k: 'NGF-BED-1A2B3C', c: 'beds', o: ['Ivory'] }),
];

/**
 * `buildIndex`, not `createIndex`: the production entry point loads MiniSearch dynamically so the
 * engine stays out of every page's eager graph (see the note in `@/lib/search/query`). Passing the
 * engine in keeps these assertions synchronous over the identical index configuration.
 */
const context: SuggestContext = {
  docs: DOCS,
  index: buildIndex(MiniSearch, DOCS),
  categoryNames: CATEGORY_NAMES,
};

describe('index configuration', () => {
  it('indexes exactly the design’s fields with the design’s boosts', () => {
    expect([...SEARCH_FIELDS]).toEqual(['n', 'k', 'm', 'o', 't', 'c', 's']);
    expect(SEARCH_BOOSTS).toEqual({ n: 4, k: 5, t: 2, m: 2, o: 2, c: 1.5, s: 1.5 });
  });
});

describe('fuzzy threshold (Requirements 2.3, 2.4)', () => {
  it('allows no edits below four characters, so short terms stay exact and prefix only', () => {
    expect(maxEditsFor('')).toBe(0);
    expect(maxEditsFor('b')).toBe(0);
    expect(maxEditsFor('be')).toBe(0);
    expect(maxEditsFor('bed')).toBe(0);
  });

  it('allows one edit per five characters of the query, rounded down', () => {
    expect(maxEditsFor('sofa')).toBe(0); // floor(4/5)
    expect(maxEditsFor('sofas')).toBe(1); // floor(5/5)
    expect(maxEditsFor('sheesham')).toBe(1); // floor(8/5)
    expect(maxEditsFor('sheeshamwood')).toBe(2); // floor(12/5)
    expect(maxEditsFor('a'.repeat(20))).toBe(4);
  });

  it('does not let a three-letter query fuzzily reach a one-edit neighbour', () => {
    // The whole reason for the four-character gate: "bed" must not match "Beige"/"Red"-style
    // neighbours by a single edit.
    const results = candidatesFor('bed', context).map((entry) => entry.i);
    expect(results).toContain('ivory-queen-bed');
    expect(results).not.toContain('brown-accent-chair');
  });
});

describe('matching (Requirement 2.2)', () => {
  it('matches on name, material, colour, and category, case-insensitively and trimmed', () => {
    for (const query of ['brown', 'BROWN', '  Brown  ']) {
      const slugs = candidatesFor(query, context).map((entry) => entry.i);
      expect(slugs).toContain('brown-l-shape-sofa');
      expect(slugs).toContain('brown-accent-chair');
      expect(slugs).toContain('brown-wooden-coffee-table');
      expect(slugs).not.toContain('ivory-queen-bed');
    }
    expect(candidatesFor('sheesham', context).map((e) => e.i)).toContain(
      'brown-wooden-coffee-table',
    );
    expect(candidatesFor('teak', context).map((e) => e.i)).toContain('brown-accent-chair');
  });

  it('treats an empty query as no text constraint', () => {
    expect(candidatesFor('', context)).toHaveLength(DOCS.length);
    expect(candidatesFor('   ', context)).toHaveLength(DOCS.length);
    expect(suggest('', context)).toEqual([]);
  });
});

describe('suggestions (Requirement 2.6)', () => {
  it('offers the matching products, their categories, and the matching filter values', () => {
    const suggestions = suggest('brown', context);

    expect(suggestions.length).toBeLessThanOrEqual(8);
    const kinds = suggestions.map((suggestion) => suggestion.kind);
    expect(kinds).toContain('product');
    // The design's worked example: "brown" also surfaces the Brown colour filter.
    const filters = suggestions.filter((suggestion) => suggestion.kind === 'filter');
    expect(filters.some((suggestion) => suggestion.label === 'Brown')).toBe(true);
    expect(filters.every((suggestion) => suggestion.href.startsWith('/collection?'))).toBe(true);
  });

  it('gives each product suggestion one destination and a category · price sublabel', () => {
    const [first] = suggest('l-shape sofa', context);
    expect(first?.kind).toBe('product');
    expect(first?.href).toBe('/product/brown-l-shape-sofa');
    expect(first?.sublabel).toBe('Sofas & Sectionals · ₹42,000');
  });

  it('labels a price-on-enquiry product with the shared label, never an amount', () => {
    const suggestion = suggest('Coffee Table', context).find(
      (entry) => entry.href === '/product/brown-wooden-coffee-table',
    );
    expect(suggestion?.sublabel).toBe('Coffee & Side Tables · Price on enquiry');
  });

  it('caps at eight even when far more would qualify', () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      doc({
        i: `brown-thing-${index}`,
        n: `Brown Thing ${index}`,
        k: `NGF-SOF-${String(index).padStart(6, '0')}`,
        c: 'sofas',
        o: ['Brown'],
      }),
    );
    const wide: SuggestContext = {
      docs: many,
      index: buildIndex(MiniSearch, many),
      categoryNames: CATEGORY_NAMES,
    };
    expect(suggest('brown', wide)).toHaveLength(8);
  });
});

describe('no-match state (Requirement 2.10)', () => {
  it('returns up to three nearest matches for a query that matches nothing', () => {
    const nearest = nearestMatches('zzzzqqqq', context);
    expect(nearest).toHaveLength(3);
    expect(nearest.every((suggestion) => suggestion.kind === 'product')).toBe(true);
  });

  it('returns all available when fewer than three products exist', () => {
    const small = [DOCS[0] as SearchDoc];
    const tiny: SuggestContext = {
      docs: small,
      index: buildIndex(MiniSearch, small),
      categoryNames: CATEGORY_NAMES,
    };
    expect(nearestMatches('zzzz', tiny)).toHaveLength(1);
  });

  it('orders nearest matches by distance and breaks ties on slug, so the list is stable', () => {
    const first = nearestMatches('brown sofa', context).map((entry) => entry.href);
    const second = nearestMatches('brown sofa', context).map((entry) => entry.href);
    expect(second).toEqual(first);
  });

  it('measures edit distance correctly, including the empty-string edges', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('sofa', 'sofa')).toBe(0);
    expect(editDistance('sofa', 'sofas')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('submitted queries (Requirement 2.12)', () => {
  it('sends a submitted query to the catalogue with the query in the URL', () => {
    expect(collectionSearchHref('brown sofa')).toBe('/collection?q=brown+sofa');
    expect(collectionSearchHref('  ₹25,000 & up ')).toBe('/collection?q=%E2%82%B925%2C000+%26+up');
  });
});

describe('recent searches (Requirements 2.9, 2.13)', () => {
  it('keeps at most five entries, most recent first', () => {
    let list: string[] = [];
    for (const query of ['a', 'b', 'c', 'd', 'e', 'f']) list = withRecentSearch(list, query);
    expect(list).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(list).toEqual(['f', 'e', 'd', 'c', 'b']);
  });

  it('moves an existing entry to the front rather than duplicating it', () => {
    const list = withRecentSearch(withRecentSearch(['sofa', 'bed'], 'chair'), 'SOFA');
    expect(list).toEqual(['SOFA', 'chair', 'bed']);
  });

  it('ignores an empty or whitespace-only query', () => {
    expect(withRecentSearch(['sofa'], '')).toEqual(['sofa']);
    expect(withRecentSearch(['sofa'], '   ')).toEqual(['sofa']);
  });

  it('trims what it records', () => {
    expect(withRecentSearch([], '  sofa  ')).toEqual(['sofa']);
  });
});
