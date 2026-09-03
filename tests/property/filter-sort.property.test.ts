import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  clearFilters,
  facetCounts,
  facetVocabulary,
  filter,
  isNeutral,
  MULTI_DIMENSIONS,
  neutralState,
  toggleValue,
} from '@/lib/search/filter';
import type { FilterState, MultiDimension } from '@/lib/search/filter';
import { comparatorFor, sortDocs, SORT_KEYS } from '@/lib/search/sort';
import type { RankingContext, SortKey } from '@/lib/search/sort';
import type { SearchDoc } from '@/lib/search/types';
import { parseFilters, serializeFilters } from '@/lib/search/url';

import {
  distinctSearchDocsArb,
  filterStateArb,
  filterStateForArb,
  searchDocArb,
} from './arbitraries';
import type { FilterStateLike } from './arbitraries';
import { assertProperty } from './config';

/**
 * The filter and sort engine.
 *
 * Design: Catalogue → Filters, Sorting with honest fallbacks.
 */

const asState = (state: FilterStateLike): FilterState => ({ ...state });

/** Ranking contexts that exercise both the measured and the curated paths of every sort. */
const rankingContextArb: fc.Arbitrary<RankingContext> = fc.oneof(
  fc.constant<RankingContext>({
    manual: { trending: [], bestSeller: [], mostViewed: [] },
    snapshot: null,
  }),
  fc
    .tuple(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
    )
    .map(([trending, bestSeller, mostViewed]) => ({
      manual: { trending, bestSeller, mostViewed },
      snapshot: null,
    })),
);

/** Two-pointer subsequence check: is `part` a subsequence of `whole`, by identity? */
function isSubsequence(part: readonly SearchDoc[], whole: readonly SearchDoc[]): boolean {
  let cursor = 0;
  for (const item of part) {
    while (cursor < whole.length && whole[cursor] !== item) cursor += 1;
    if (cursor >= whole.length) return false;
    cursor += 1;
  }
  return true;
}

function slugMultiset(docs: readonly SearchDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs) counts.set(doc.i, (counts.get(doc.i) ?? 0) + 1);
  return counts;
}

/* -------------------------------------------------------------------------- */

describe('Property 31: Filtering is an order-preserving subsequence', () => {
  it('returns a subsequence of its input, with no duplication and no invention', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 14 }), filterStateArb, (docs, raw) => {
        const result = filter(docs, asState(raw));
        expect(isSubsequence(result, docs)).toBe(true);
        // No duplication: each returned document is a distinct member of the input.
        expect(new Set(result).size).toBe(result.length);
        for (const doc of result) expect(docs).toContain(doc);
      }),
    );
  });

  it('holds for states drawn from the documents themselves, so the result is non-trivial', () => {
    assertProperty(
      fc.property(
        fc
          .array(searchDocArb, { minLength: 1, maxLength: 12 })
          .chain((docs) => filterStateForArb(docs).map((state) => ({ docs, state }))),
        ({ docs, state }) => {
          expect(isSubsequence(filter(docs, asState(state)), docs)).toBe(true);
        },
      ),
    );
  });
});

describe('Property 32: Sorting is a permutation', () => {
  it('returns the same multiset of slugs, for every sort key', () => {
    assertProperty(
      fc.property(
        fc.array(searchDocArb, { maxLength: 16 }),
        fc.constantFrom(...SORT_KEYS),
        rankingContextArb,
        (docs, key, ranking) => {
          const sorted = sortDocs(docs, key, ranking);
          expect(sorted).toHaveLength(docs.length);
          expect(slugMultiset(sorted)).toEqual(slugMultiset(docs));
        },
      ),
    );
  });

  it('does not mutate its input', () => {
    assertProperty(
      fc.property(
        fc.array(searchDocArb, { maxLength: 10 }),
        fc.constantFrom(...SORT_KEYS),
        (docs, key) => {
          const before = [...docs];
          sortDocs(docs, key);
          expect(docs).toEqual(before);
        },
      ),
    );
  });
});

describe('Property 33: Sorting is idempotent and stable', () => {
  it('sorting a sorted set changes nothing', () => {
    assertProperty(
      fc.property(
        // Many tied values: a small price set and a small timestamp set force ties, which is what
        // exposes an unstable comparator.
        fc.array(searchDocArb, { maxLength: 14 }).map((docs) =>
          docs.map((doc, index) => ({
            ...doc,
            i: `${doc.i}-${index}`,
            p: index % 3 === 0 ? null : 25_000,
            ts: 1_700_000_000,
            f: 0,
          })),
        ),
        fc.constantFrom(...SORT_KEYS),
        rankingContextArb,
        (docs, key, ranking) => {
          const once = sortDocs(docs, key, ranking);
          const twice = sortDocs(once, key, ranking);
          expect(twice.map((doc) => doc.i)).toEqual(once.map((doc) => doc.i));
          // And the order does not depend on the input order: a shuffle sorts identically.
          const reversed = sortDocs([...docs].reverse(), key, ranking);
          expect(reversed.map((doc) => doc.i)).toEqual(once.map((doc) => doc.i));
        },
      ),
    );
  });
});

describe('Property 34: Every comparator is a total order', () => {
  it('is antisymmetric, transitive, and total across distinct products', () => {
    assertProperty(
      fc.property(
        distinctSearchDocsArb({ minLength: 3, maxLength: 3 }),
        fc.constantFrom(...SORT_KEYS),
        rankingContextArb,
        (docs, key, ranking) => {
          const [a, b, c] = docs as [SearchDoc, SearchDoc, SearchDoc];
          const cmp = comparatorFor(key, ranking);

          // Antisymmetry, on sign rather than magnitude.
          for (const [x, y] of [
            [a, b],
            [b, c],
            [a, c],
          ] as const) {
            expect(Math.sign(cmp(x, y))).toBe(-Math.sign(cmp(y, x)));
          }

          // Reflexivity.
          for (const x of [a, b, c]) expect(cmp(x, x)).toBe(0);

          // Totality: distinct slugs never compare equal, because every branch tie-breaks on slug.
          for (const [x, y] of [
            [a, b],
            [b, c],
            [a, c],
          ] as const) {
            if (x.i !== y.i) expect(cmp(x, y)).not.toBe(0);
          }

          // Transitivity, over the sorted triple so the antecedent always holds.
          const sorted = [a, b, c].sort(cmp);
          const [first, second, third] = sorted as [SearchDoc, SearchDoc, SearchDoc];
          expect(cmp(first, second)).toBeLessThanOrEqual(0);
          expect(cmp(second, third)).toBeLessThanOrEqual(0);
          expect(cmp(first, third)).toBeLessThanOrEqual(0);
        },
      ),
    );
  });
});

describe('Property 35: Price sort orders prices and tails price-on-enquiry', () => {
  it('orders priced products and places price-on-enquiry last in both directions', () => {
    assertProperty(
      fc.property(
        distinctSearchDocsArb({ maxLength: 16 }),
        fc.constantFrom<SortKey[]>('priceAsc', 'priceDesc'),
        (docs, key) => {
          const sorted = sortDocs(docs, key);
          const priced = sorted.filter((doc) => doc.p !== null);
          const onEnquiry = sorted.filter((doc) => doc.p === null);

          // Every price-on-enquiry document comes after every priced one.
          const firstOnEnquiry = sorted.findIndex((doc) => doc.p === null);
          const lastPriced = sorted.reduce(
            (last, doc, index) => (doc.p !== null ? index : last),
            -1,
          );
          if (firstOnEnquiry >= 0 && lastPriced >= 0) {
            expect(firstOnEnquiry).toBeGreaterThan(lastPriced);
          }
          expect(priced.length + onEnquiry.length).toBe(docs.length);

          // Prices are monotone in the selected direction.
          for (let index = 1; index < priced.length; index += 1) {
            const previous = priced[index - 1]?.p ?? 0;
            const current = priced[index]?.p ?? 0;
            if (key === 'priceAsc') expect(previous).toBeLessThanOrEqual(current);
            else expect(previous).toBeGreaterThanOrEqual(current);
          }
        },
      ),
    );
  });

  it('excludes price-on-enquiry from every banded filter and keeps it under Any', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 12 }), (docs) => {
        const onEnquiry = docs.filter((doc) => doc.p === null);
        for (const band of ['under25k', '25k-50k', '50k-1L', '1L+'] as const) {
          const result = filter(docs, { ...neutralState(), priceBand: band });
          for (const doc of onEnquiry) expect(result).not.toContain(doc);
        }
        const any = filter(docs, { ...neutralState(), priceBand: 'any' });
        for (const doc of onEnquiry) expect(any).toContain(doc);
      }),
    );
  });
});

describe('Property 36: Filtering never grows the set, and the neutral state is the identity', () => {
  it('never returns more than it was given', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 16 }), filterStateArb, (docs, raw) => {
        expect(filter(docs, asState(raw)).length).toBeLessThanOrEqual(docs.length);
      }),
    );
  });

  it('the all-any neutral state is the identity, and is recognised as neutral', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 16 }), (docs) => {
        const state = neutralState();
        expect(isNeutral(state)).toBe(true);
        expect(filter(docs, state)).toEqual([...docs]);
        // The sort selection is not a filter: changing it cannot change the set.
        for (const sort of SORT_KEYS) {
          expect(filter(docs, { ...state, sort })).toEqual([...docs]);
        }
      }),
    );
  });

  it('clearing filters restores the full set while retaining the sort', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 12 }), filterStateArb, (docs, raw) => {
        const cleared = clearFilters(asState(raw));
        expect(cleared.sort).toBe(raw.sort);
        expect(cleared.q).toBe(raw.q);
        expect(isNeutral(cleared)).toBe(true);
        expect(filter(docs, cleared)).toEqual([...docs]);
      }),
    );
  });
});

describe('Property 37: Adding a constraint is monotone', () => {
  it('refining a state can only shrink the result set', () => {
    assertProperty(
      fc.property(
        fc.array(searchDocArb, { minLength: 1, maxLength: 12 }).chain((docs) =>
          fc
            .tuple(
              filterStateForArb(docs),
              fc.constantFrom<MultiDimension[]>(...MULTI_DIMENSIONS),
              fc.constantFrom(
                'any' as const,
                'under25k' as const,
                '25k-50k' as const,
                '50k-1L' as const,
                '1L+' as const,
              ),
              fc.constantFrom('any' as const, 'inStock' as const, 'madeToOrder' as const),
            )
            .map(([state, dimension, band, availability]) => ({
              docs,
              state,
              dimension,
              band,
              availability,
            })),
        ),
        ({ docs, state, dimension, band, availability }) => {
          const base = asState(state);
          const baseResult = filter(docs, base);

          // Refinement 1: narrow a multi-select dimension to a single already-selected value.
          const selected = base[dimension];
          if (selected.length > 1) {
            const narrowed: FilterState = { ...base, [dimension]: [selected[0] as string] };
            for (const doc of filter(docs, narrowed)) expect(baseResult).toContain(doc);
          }

          // Refinement 2: constrain a dimension the base state leaves unconstrained.
          if (base.priceBand === 'any' && band !== 'any') {
            for (const doc of filter(docs, { ...base, priceBand: band })) {
              expect(baseResult).toContain(doc);
            }
          }
          if (base.availability === 'any' && availability !== 'any') {
            for (const doc of filter(docs, { ...base, availability })) {
              expect(baseResult).toContain(doc);
            }
          }

          // Refinement 3: constrain an empty multi-select dimension with any real value.
          for (const other of MULTI_DIMENSIONS) {
            if (base[other].length !== 0) continue;
            const vocabulary = facetVocabulary(docs)[other];
            const value = vocabulary[0];
            if (value === undefined) continue;
            for (const doc of filter(docs, { ...base, [other]: [value] })) {
              expect(baseResult).toContain(doc);
            }
          }
        },
      ),
    );
  });

  it('adding a value to a dimension can only grow that dimension’s result set', () => {
    assertProperty(
      fc.property(
        fc.array(searchDocArb, { minLength: 1, maxLength: 12 }),
        fc.constantFrom<MultiDimension[]>(...MULTI_DIMENSIONS),
        (docs, dimension) => {
          const vocabulary = facetVocabulary(docs)[dimension];
          const [first, second] = vocabulary;
          if (first === undefined || second === undefined) return;
          const one = filter(docs, { ...neutralState(), [dimension]: [first] });
          const both = filter(docs, { ...neutralState(), [dimension]: [first, second] });
          // OR within a dimension: widening the selection is monotone the other way.
          for (const doc of one) expect(both).toContain(doc);
        },
      ),
    );
  });
});

describe('Property 38: Filter state round-trips through the URL', () => {
  it('parseFilters(serializeFilters(s)) === s', () => {
    assertProperty(
      fc.property(filterStateArb, (raw) => {
        const state = asState(raw);
        expect(parseFilters(serializeFilters(state))).toEqual(state);
      }),
    );
  });

  it('serialization is canonical: the same state always yields the same string', () => {
    assertProperty(
      fc.property(filterStateArb, (raw) => {
        const state = asState(raw);
        expect(serializeFilters({ ...state })).toBe(serializeFilters(state));
      }),
    );
  });

  it('the neutral state serializes to an empty query string, and back', () => {
    const state = neutralState();
    expect(serializeFilters(state)).toBe('');
    expect(parseFilters('')).toEqual(state);
    expect(parseFilters('?')).toEqual(state);
  });

  it('ignores only the unrecognised, malformed, or valueless parameter', () => {
    assertProperty(
      fc.property(
        filterStateArb,
        fc.constantFrom(
          'unknown=1',
          'price=cheap',
          'availability=maybe',
          'sort=random',
          'colour=',
          'category=',
          'q=%20%20',
        ),
        (raw, junk) => {
          const state = asState(raw);
          const serialized = serializeFilters(state);
          const polluted = serialized === '' ? junk : `${serialized}&${junk}`;
          // Every valid parameter survives; the junk one is dropped and nothing throws.
          expect(parseFilters(polluted)).toEqual(state);
        },
      ),
    );
  });

  it('drops values naming something absent from the catalogue when a vocabulary is supplied', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { minLength: 1, maxLength: 10 }), (docs) => {
        const vocabulary = facetVocabulary(docs);
        const parsed = parseFilters(
          'colour=NotAColourAnyProductHas&category=no-such-category',
          vocabulary,
        );
        expect(parsed.colour).toEqual([]);
        expect(parsed.category).toEqual([]);
      }),
    );
  });

  it('is total: no query string throws, whatever it contains', () => {
    assertProperty(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (search) => {
        expect(() => parseFilters(search)).not.toThrow();
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Facet counts — Requirements 3.7 and 3.8                                    */
/* -------------------------------------------------------------------------- */

describe('facet counts', () => {
  it('each count equals the result size when that option is selected alongside the others', () => {
    assertProperty(
      fc.property(
        fc
          .array(searchDocArb, { minLength: 1, maxLength: 10 })
          .chain((docs) => filterStateForArb(docs).map((state) => ({ docs, state }))),
        ({ docs, state }) => {
          const base = asState(state);
          const facets = facetCounts(docs, base);

          for (const dimension of MULTI_DIMENSIONS) {
            for (const option of facets[dimension]) {
              const expected = filter(docs, { ...base, [dimension]: [option.value] }).length;
              expect(option.count).toBe(expected);
              expect(option.disabled).toBe(expected === 0);
            }
          }
          for (const option of facets.priceBand) {
            const expected = filter(docs, {
              ...base,
              priceBand: option.value as FilterState['priceBand'],
            }).length;
            expect(option.count).toBe(expected);
          }
          for (const option of facets.availability) {
            const expected = filter(docs, {
              ...base,
              availability: option.value as FilterState['availability'],
            }).length;
            expect(option.count).toBe(expected);
          }
        },
      ),
    );
  });

  it('derives every option from the data — no option names a value no product has', () => {
    assertProperty(
      fc.property(fc.array(searchDocArb, { maxLength: 10 }), (docs) => {
        const facets = facetCounts(docs, neutralState());
        const vocabulary = facetVocabulary(docs);
        for (const dimension of MULTI_DIMENSIONS) {
          expect(facets[dimension].map((option) => option.value)).toEqual(vocabulary[dimension]);
        }
        // Requirement 3.2 / 3.3: the band and availability option sets are fixed and complete.
        expect(facets.priceBand.map((option) => option.value)).toEqual([
          'any',
          'under25k',
          '25k-50k',
          '50k-1L',
          '1L+',
        ]);
        expect(facets.availability.map((option) => option.value)).toEqual([
          'any',
          'inStock',
          'madeToOrder',
        ]);
      }),
    );
  });

  it('toggling a value twice returns to the original state', () => {
    assertProperty(
      fc.property(
        filterStateArb,
        fc.constantFrom<MultiDimension[]>(...MULTI_DIMENSIONS),
        fc.constantFrom('Brown', 'Teak', 'Queen', 'sofas', 'premium'),
        (raw, dimension, value) => {
          const state = asState(raw);
          const once = toggleValue(state, dimension, value);
          const twice = toggleValue(once, dimension, value);
          expect(twice[dimension].map((entry) => entry.toLowerCase()).sort()).toEqual(
            state[dimension].map((entry) => entry.toLowerCase()).sort(),
          );
        },
      ),
    );
  });
});
