/**
 * The catalogue URL vocabulary: the query-string parameter names, and the one URL builder the search
 * box needs.
 *
 * **Why this is a separate module from `url.ts`.** `url.ts` is the filter *serializer* — round-trip
 * parsing, facet vocabularies, canonicalisation — about 2 kB of it, needed only on `/collection`. The
 * search box in the shell needs exactly two things from that area: the `q` parameter name and the
 * `/collection?q=…` builder, and it needs them in its render path on every page of the site. While
 * they lived in `url.ts`, every page paid 2 kB for three lines. Splitting the constants out costs
 * nothing and `url.ts` re-exports them, so no existing importer changed.
 *
 * These names are public URLs. They are short, lowercase, and stable: changing one breaks every
 * shared link and every bookmark that carries a filter.
 *
 * Requirements: 2.9, 3.9, 22.4.
 */

import type { MultiDimension } from './filter';

/** Query-string keys, one per dimension. */
export const PARAM_NAMES: Readonly<Record<MultiDimension, string>> = {
  category: 'category',
  material: 'material',
  colour: 'colour',
  size: 'size',
  style: 'style',
};

export const PARAM_PRICE_BAND = 'price';
export const PARAM_AVAILABILITY = 'availability';
export const PARAM_SORT = 'sort';
export const PARAM_QUERY = 'q';

/** Every parameter the catalogue recognises. Anything else in a URL is ignored. */
export const KNOWN_PARAMS: readonly string[] = [
  ...Object.values(PARAM_NAMES),
  PARAM_PRICE_BAND,
  PARAM_AVAILABILITY,
  PARAM_SORT,
  PARAM_QUERY,
];

/** The `/collection` URL for a submitted query — where Enter with no active option goes. */
export function collectionSearchHref(query: string): string {
  const params = new URLSearchParams();
  params.set(PARAM_QUERY, query.trim());
  return `/collection?${params.toString()}`;
}
