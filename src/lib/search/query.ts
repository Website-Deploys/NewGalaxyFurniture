/**
 * Client-side matching and suggestions, over MiniSearch.
 *
 * Four behaviours here are specified precisely and implemented deliberately:
 *
 * 1. **Fuzzy only at four characters or more** (Requirements 2.3, 2.4). `maxEditsFor` returns
 *    `Math.floor(length / 5)` for terms of four or more characters and 0 below that. Two
 *    consequences worth stating plainly rather than discovering later:
 *      - Short terms stay exact-and-prefix, so `bed` cannot fuzzily match `red`. That is the
 *        whole reason the threshold exists.
 *      - At *exactly* four characters `floor(4/5)` is 0, so a four-character query behaves like
 *        a three-character one. The design's shorthand ("fuzzy 0.2 for terms of four or more")
 *        would round that to one edit, but Requirement 2.3 caps the tolerance at
 *        "one character edit per five characters of the query, **rounded down**", and exceeding
 *        a stated maximum is the worse of the two deviations. The rounded-down rule governs.
 * 2. **A complete SKU in any case ranks first** (Requirement 2.5). Not left to relevance
 *    scoring — an exact case-folded SKU hit is hoisted to position 0 before ranking is
 *    consulted. Boosting `k` heavily makes that *likely*; hoisting makes it *true*, which is
 *    what Property 39 asserts.
 * 3. **At most eight suggestions, products then categories then filters** (Requirement 2.6),
 *    with the products drawn from ranked matches and the category and filter rows synthesised
 *    from what the query matched — so typing `brown` surfaces the brown products *and* the
 *    "Brown" colour filter.
 * 4. **The no-match state is never empty** (Requirement 2.10): `nearestMatches` returns up to
 *    three most-similar products by edit distance over name and SKU, which the UI shows
 *    alongside category shortcuts.
 *
 * Everything in this module is pure with respect to the index it is given, so it is testable
 * without a DOM.
 *
 * Design: Catalogue → Matching.
 * Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.10, 2.11.
 */

import type MiniSearch from 'minisearch';

import { formatINR, PRICE_ON_ENQUIRY_LABEL } from '@/lib/money';
import { facetKey } from './filter';
import { PARAM_NAMES } from './params';
import { productHref } from './types';
import type { SearchDoc } from './types';

export { collectionSearchHref } from './params';

/** The fields MiniSearch indexes, with the design's boosts. */
export const SEARCH_FIELDS = ['n', 'k', 'm', 'o', 't', 'c', 's'] as const;

export const SEARCH_BOOSTS: Readonly<Record<string, number>> = {
  n: 4,
  k: 5,
  t: 2,
  m: 2,
  o: 2,
  c: 1.5,
  s: 1.5,
};

/** Requirement 2.3: one edit per five characters, rounded down; nothing below four chars. */
export function maxEditsFor(term: string): number {
  if (term.length < 4) return 0;
  return Math.floor(term.length / 5);
}

/** Case- and diacritic-folded, whitespace-collapsed. The comparison form for SKUs and terms. */
export function fold(value: string): string {
  return facetKey(value);
}

/**
 * Build the searchable index.
 *
 * `o` and `t` are arrays; MiniSearch needs a string per field, so they are joined. Joining with
 * a space (rather than indexing per element) is correct because the tokenizer splits on
 * whitespace anyway, and it keeps the extraction function trivial.
 */
export function buildIndex(
  MiniSearchImpl: typeof MiniSearch,
  docs: readonly SearchDoc[],
): MiniSearch<SearchDoc> {
  const index = new MiniSearchImpl<SearchDoc>({
    idField: 'i',
    fields: [...SEARCH_FIELDS],
    storeFields: [],
    extractField: (doc, field) => {
      const value = (doc as unknown as Record<string, unknown>)[field];
      if (Array.isArray(value)) return value.join(' ');
      return typeof value === 'string' ? value : '';
    },
    searchOptions: {
      prefix: true,
      boost: SEARCH_BOOSTS,
      fuzzy: (term) => maxEditsFor(term),
    },
  });
  index.addAll([...docs]);
  return index;
}

/**
 * Build the index, loading the engine on demand.
 *
 * **MiniSearch is dynamically imported here rather than statically imported at the top of this
 * module**, and that is a budget decision with teeth. The design lists "dynamic import for … the
 * search index" among the binding techniques and states the `/collection` budget as "≤ 70 KB
 * *excluding the lazy index*". A static import would put the 7.9 kB engine in the eager graph of
 * every page that imports anything from this module — which is every page, because the header search
 * box is part of the shell — leaving the index lazy and the *engine* eager. It cost 7.9 kB on
 * twenty-four pages, including pages with no search interaction at all.
 *
 * It costs no extra round trip: both call sites `await` a `fetch` of the index immediately before
 * this, so the engine and the data it operates on arrive together, on first search intent.
 *
 * `buildIndex` above is the same construction with the engine passed in, so a test can build an
 * index synchronously without either duplicating the configuration or turning every assertion async.
 */
export async function createIndex(docs: readonly SearchDoc[]): Promise<MiniSearch<SearchDoc>> {
  const { default: MiniSearchImpl } = await import('minisearch');
  return buildIndex(MiniSearchImpl, docs);
}

export interface SuggestionThumb {
  src: string;
  lqip: string;
}

export interface Suggestion {
  kind: 'product' | 'category' | 'filter';
  label: string;
  /** "Sofas & Sectionals · ₹42,000" */
  sublabel?: string;
  href: string;
  thumb?: SuggestionThumb;
}

export const SUGGESTION_LIMIT = 8;

export interface SuggestContext {
  docs: readonly SearchDoc[];
  index: MiniSearch<SearchDoc>;
  /** Category slug → display name, so a suggestion reads "Sofas & Sectionals". */
  categoryNames: Readonly<Record<string, string>>;
}

/** Ranked product slugs for a query, SKU hits hoisted. Exported for Property 39. */
export function rankedSlugs(query: string, context: SuggestContext): string[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const results = context.index.search(trimmed).map((result) => String(result.id));

  // Requirement 2.5. An exact, case-insensitive whole-SKU match is a precise lookup, not a
  // relevance judgement, so it goes first regardless of score.
  const needle = fold(trimmed);
  const exact = context.docs.filter((doc) => fold(doc.k) === needle).map((doc) => doc.i);
  if (exact.length === 0) return results;

  const hoisted = new Set(exact);
  return [...exact, ...results.filter((slug) => !hoisted.has(slug))];
}

function docBySlug(context: SuggestContext, slug: string): SearchDoc | undefined {
  return context.docs.find((doc) => doc.i === slug);
}

function productSuggestion(doc: SearchDoc, context: SuggestContext): Suggestion {
  const category = context.categoryNames[doc.c] ?? doc.c;
  const price = doc.p === null ? PRICE_ON_ENQUIRY_LABEL : formatINR(doc.p);
  return {
    kind: 'product',
    label: doc.n,
    sublabel: `${category} · ${price}`,
    href: productHref(doc),
    ...(doc.th === '' ? {} : { thumb: { src: doc.th, lqip: doc.lq } }),
  };
}

/**
 * Category rows: categories whose display name or slug the query prefixes, plus the categories
 * the matched products belong to. The second source is what makes a query like `sheesham`
 * offer "Beds" — the visitor's word is not a category name but the answer is a category.
 */
function categorySuggestions(
  query: string,
  matched: readonly SearchDoc[],
  context: SuggestContext,
): Suggestion[] {
  const needle = fold(query);
  const out = new Map<string, Suggestion>();

  const add = (slug: string): void => {
    if (out.has(slug)) return;
    const name = context.categoryNames[slug] ?? slug;
    const count = context.docs.filter((doc) => doc.c === slug).length;
    out.set(slug, {
      kind: 'category',
      label: name,
      sublabel: count === 1 ? '1 product' : `${count} products`,
      href: `/collection/${slug}`,
    });
  };

  for (const [slug, name] of Object.entries(context.categoryNames)) {
    if (needle !== '' && (fold(name).includes(needle) || fold(slug).includes(needle))) add(slug);
  }
  for (const doc of matched) add(doc.c);

  return [...out.values()];
}

/**
 * Filter rows: the colour, material, and style values the query names.
 *
 * This is the worked example in the design — typing `brown` should offer the "Brown" colour
 * filter as well as the brown products — and it is why facet values live in the index.
 */
function filterSuggestions(query: string, context: SuggestContext): Suggestion[] {
  const needle = fold(query);
  if (needle === '') return [];

  const out: Suggestion[] = [];
  const seen = new Set<string>();

  const consider = (dimension: 'colour' | 'material' | 'style', value: string): void => {
    const key = `${dimension}:${fold(value)}`;
    if (seen.has(key) || !fold(value).includes(needle)) return;
    seen.add(key);
    const params = new URLSearchParams();
    params.set(PARAM_NAMES[dimension], value);
    out.push({
      kind: 'filter',
      label: value,
      sublabel: dimension === 'colour' ? 'Colour' : dimension === 'material' ? 'Material' : 'Style',
      href: `/collection?${params.toString()}`,
    });
  };

  for (const doc of context.docs) {
    for (const colour of doc.o) consider('colour', colour);
    if (doc.m !== undefined) consider('material', doc.m);
    for (const tag of doc.t) consider('style', tag);
  }
  return out;
}

/**
 * Up to eight suggestions, products then categories then filters (Requirement 2.6).
 *
 * The ordering is a hard sequence, not a score mix: a visitor scanning the list expects the
 * specific thing they typed to be at the top, and a category row above a product row that
 * matches better is disorienting.
 */
export function suggest(
  query: string,
  context: SuggestContext,
  limit = SUGGESTION_LIMIT,
): Suggestion[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  const matched = rankedSlugs(trimmed, context)
    .map((slug) => docBySlug(context, slug))
    .filter((doc): doc is SearchDoc => doc !== undefined);

  const products = matched.map((doc) => productSuggestion(doc, context));
  const categories = categorySuggestions(trimmed, matched, context);
  const filters = filterSuggestions(trimmed, context);

  return [...products, ...categories, ...filters].slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* No-match state                                                             */
/* -------------------------------------------------------------------------- */

/** Levenshtein distance, iterative two-row. Small strings only; no allocation per cell. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

/**
 * The nearest products to a query that matched nothing (Requirement 2.10).
 *
 * Distance is measured against the name and the SKU and the best of the two wins, because a
 * mistyped SKU and a mistyped name are both common and neither should be privileged. Ties break
 * on slug so the "did you mean" list is stable.
 */
export function nearestMatches(query: string, context: SuggestContext, limit = 3): Suggestion[] {
  const needle = fold(query);
  if (needle === '') return [];

  return [...context.docs]
    .map((doc) => ({
      doc,
      distance: Math.min(editDistance(needle, fold(doc.n)), editDistance(needle, fold(doc.k))),
    }))
    .sort((a, b) => a.distance - b.distance || (a.doc.i < b.doc.i ? -1 : 1))
    .slice(0, limit)
    .map((entry) => productSuggestion(entry.doc, context));
}

/**
 * Documents matching a free-text query, for the catalogue listing.
 *
 * Separate from `suggest` because the listing wants a *set* to hand to `filter`, in relevance
 * order, with no cap. An empty query means "no text constraint" and returns everything, which
 * is what keeps `filter`'s neutral state the identity.
 */
export function candidatesFor(query: string, context: SuggestContext): SearchDoc[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...context.docs];
  return rankedSlugs(trimmed, context)
    .map((slug) => docBySlug(context, slug))
    .filter((doc): doc is SearchDoc => doc !== undefined);
}
