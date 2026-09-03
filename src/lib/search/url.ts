/**
 * Filter and sort state ⇄ URL query string.
 *
 * A filtered catalogue view has to be shareable, bookmarkable, and survive back/forward
 * (Requirements 3.5, 3.6, 3.20), which means the query string is the state — not a cache of
 * it. Two encoding decisions make that work:
 *
 * 1. **Repeated parameters, not comma-joined lists.** `?colour=Brown&colour=Walnut`, never
 *    `?colour=Brown,Walnut`. Facet values are operator-entered strings that legitimately
 *    contain commas ("Fabric, hardwood frame"), and a delimiter that can appear inside a value
 *    is a round-trip bug waiting for the first such product. Repetition also preserves
 *    selection order for free.
 * 2. **The neutral state serializes to the empty string.** `priceBand=any`, `sort=newest`, an
 *    empty `q`, and empty arrays are all omitted, so a freshly loaded `/collection` has a clean
 *    URL and the round-trip is still exact (Property 38).
 *
 * `parseFilters` is **total**: it never throws and never rejects a whole URL. An unrecognised
 * key, a malformed value, or a value naming something absent from the catalogue is dropped
 * *individually* and everything else is applied (Requirement 3.19). Re-serializing the parsed
 * state is what the caller writes back to the address bar, so the URL always describes exactly
 * what is on screen.
 *
 * Design: Catalogue → Filters.
 * Requirements: 3.5, 3.6, 3.18, 3.19, 3.20.
 */

import { PRICE_BANDS } from '@/lib/money';
import type { PriceBandFilter } from '@/lib/money';
import { AVAILABILITY_OPTIONS, facetKey, MULTI_DIMENSIONS, neutralState } from './filter';
import type { AvailabilityFilter, FilterState, MultiDimension } from './filter';
import {
  PARAM_AVAILABILITY,
  PARAM_NAMES,
  PARAM_PRICE_BAND,
  PARAM_QUERY,
  PARAM_SORT,
} from './params';
import { SORT_KEYS } from './sort';
import type { SortKey } from './sort';

/*
 * The parameter names and `collectionSearchHref` live in `./params`, which is a few hundred bytes
 * rather than this module's two kilobytes — the search box needs them on every page and needs none
 * of the serialisation below. Re-exported here so every existing importer is unaffected.
 */
export {
  collectionSearchHref,
  KNOWN_PARAMS,
  PARAM_AVAILABILITY,
  PARAM_NAMES,
  PARAM_PRICE_BAND,
  PARAM_QUERY,
  PARAM_SORT,
} from './params';

/**
 * The catalogue vocabulary used to drop URL values naming something absent from the data.
 *
 * Optional: without it, values are accepted as typed (the filter then simply matches nothing,
 * which is the correct behaviour for a parse with no catalogue in hand — for example in a
 * property test, or before the index has loaded).
 */
export type FacetVocabulary = Partial<Record<MultiDimension, readonly string[]>>;

const PRICE_BAND_VALUES: readonly string[] = PRICE_BANDS.map((band) => band.band);
const AVAILABILITY_VALUES: readonly string[] = AVAILABILITY_OPTIONS.map((option) => option.value);

/**
 * Serialize state to a query string, without the leading `?`.
 *
 * Order is fixed (dimensions in declaration order, then price, availability, sort, query) so
 * the same state always produces the same string — two links to the same view are the same
 * link, which matters for caching and for sharing.
 */
export function serializeFilters(state: FilterState): string {
  const params = new URLSearchParams();

  for (const dimension of MULTI_DIMENSIONS) {
    for (const value of state[dimension]) params.append(PARAM_NAMES[dimension], value);
  }
  if (state.priceBand !== 'any') params.set(PARAM_PRICE_BAND, state.priceBand);
  if (state.availability !== 'any') params.set(PARAM_AVAILABILITY, state.availability);
  if (state.sort !== 'newest') params.set(PARAM_SORT, state.sort);
  if (state.q !== '') params.set(PARAM_QUERY, state.q);

  return params.toString();
}

/** `?` + the query string, or the empty string — what goes into `history.pushState`. */
export function serializeFiltersAsSearch(state: FilterState): string {
  const query = serializeFilters(state);
  return query === '' ? '' : `?${query}`;
}

function readParams(search: string | URLSearchParams): URLSearchParams {
  if (search instanceof URLSearchParams) return search;
  // `URLSearchParams` tolerates a leading `?`, a bare query string, and the empty string, but
  // not a full URL — so a full URL is reduced to its query first.
  const raw = search.includes('?') ? search.slice(search.indexOf('?')) : search;
  return new URLSearchParams(raw);
}

/**
 * Values for one multi-select dimension: de-duplicated (case- and diacritic-folded), with
 * blanks and — when a vocabulary is supplied — unknown values dropped.
 */
function parseMulti(
  params: URLSearchParams,
  dimension: MultiDimension,
  vocabulary: FacetVocabulary,
): string[] {
  const allowed = vocabulary[dimension];
  const allowedKeys = allowed === undefined ? null : new Set(allowed.map(facetKey));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of params.getAll(PARAM_NAMES[dimension])) {
    const value = raw.trim();
    if (value === '') continue; // present but valueless — ignored, not an error
    const key = facetKey(value);
    if (key === '' || seen.has(key)) continue;
    if (allowedKeys !== null && !allowedKeys.has(key)) continue; // absent from the catalogue
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Parse a query string into a `FilterState`. Total: never throws, never rejects wholesale.
 *
 * Anything unrecognised is skipped and the rest applied, which is what Requirement 3.19 asks
 * for — a shared link with one stale parameter still opens the catalogue.
 */
export function parseFilters(
  search: string | URLSearchParams,
  vocabulary: FacetVocabulary = {},
): FilterState {
  const params = readParams(search);
  const state = neutralState();

  for (const dimension of MULTI_DIMENSIONS) {
    state[dimension] = parseMulti(params, dimension, vocabulary);
  }

  const band = params.get(PARAM_PRICE_BAND);
  if (band !== null && PRICE_BAND_VALUES.includes(band)) {
    state.priceBand = band as PriceBandFilter;
  }

  const availability = params.get(PARAM_AVAILABILITY);
  if (availability !== null && AVAILABILITY_VALUES.includes(availability)) {
    state.availability = availability as AvailabilityFilter;
  }

  const sort = params.get(PARAM_SORT);
  if (sort !== null && SORT_KEYS.includes(sort as SortKey)) {
    state.sort = sort as SortKey;
  }

  const q = params.get(PARAM_QUERY);
  if (q !== null && q.trim() !== '') state.q = q.trim();

  return state;
}

/**
 * The canonical query string for a URL: parse it, then re-serialize.
 *
 * This is the "rewrite the query string to the state actually applied" step of Requirement
 * 3.19, expressed as a single function so a caller cannot forget the rewrite.
 */
export function canonicalSearch(
  search: string | URLSearchParams,
  vocabulary: FacetVocabulary = {},
): string {
  return serializeFiltersAsSearch(parseFilters(search, vocabulary));
}

/** True when the URL carries something the parse discarded, so a rewrite is warranted. */
export function needsRewrite(
  search: string | URLSearchParams,
  vocabulary: FacetVocabulary = {},
): boolean {
  const params = readParams(search);
  const current = params.toString();
  return current !== serializeFilters(parseFilters(params, vocabulary));
}
