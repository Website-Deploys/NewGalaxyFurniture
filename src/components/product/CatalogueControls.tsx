/**
 * The catalogue's filter and sort island — the one place the state machine lives.
 *
 * It owns the `FilterState`, and everything else is derived from it: the facet counts, the sorted
 * result order, the URL query string, and the visible cards. Keeping that in one component is
 * what makes Requirements 3.5, 3.6, 3.19, and 3.20 consistent with each other — the URL, the
 * controls, and the grid can never disagree because they are three renderings of one value.
 *
 * The flow, in order:
 *
 * 1. **Load the index on idle**, not on page load (Requirement 22.8, design → loading strategy:
 *    `requestIdleCallback` on `/collection`). Until it arrives the prerendered grid is already on
 *    screen in Newest order, so the page is useful with no JavaScript at all.
 * 2. **Parse the URL** with the catalogue's derived vocabulary, so a parameter naming a value the
 *    catalogue does not have is dropped individually (3.19) — and then **rewrite the query string
 *    to the state actually applied**, so the address bar always describes the screen.
 * 3. **Apply** `candidatesFor(q) → filter(state) → sortDocs(state.sort)` and push the resulting
 *    slug order into the prerendered grid.
 * 4. **`pushState` on change, `popstate` on back/forward** (3.5, 3.20). The state for a history
 *    entry is re-derived from that entry's URL rather than kept in a stack, which is why
 *    back/forward restores exactly the recorded state.
 *
 * Requirements: 3.1–3.20, 22.8, 24.2.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type MiniSearch from 'minisearch';

import FilterPanel from '@/components/product/FilterPanel';
import SortControl from '@/components/product/SortControl';
import type { PriceBandFilter } from '@/lib/money';
import { applyResults } from '@/lib/search/apply-view';
import {
  clearFilters,
  facetCounts,
  facetVocabulary,
  filter,
  isNeutral,
  neutralState,
  toggleValue,
} from '@/lib/search/filter';
import type { AvailabilityFilter, FilterState, MultiDimension } from '@/lib/search/filter';
import { candidatesFor, createIndex } from '@/lib/search/query';
import type { SuggestContext } from '@/lib/search/query';
import { sortDocs } from '@/lib/search/sort';
import type { ManualRankings, RankingContext, SortKey } from '@/lib/search/sort';
import type { SearchDoc } from '@/lib/search/types';
import { parseFilters, serializeFiltersAsSearch } from '@/lib/search/url';

export interface CatalogueControlsProps {
  indexUrl: string;
  /** Category slug → display name, for the category facet labels. */
  categoryNames: Readonly<Record<string, string>>;
  /** The operator's manual orderings from `data/site/rankings.json`. */
  manualRankings: ManualRankings;
  /** Present on a category route: that route's grid holds only this category. */
  scopeCategory?: string;
  /** The id of the element wrapping the prerendered card grid. */
  gridId: string;
  /** The id of the server-rendered no-match composition this island toggles. */
  noMatchId: string;
}

export default function CatalogueControls({
  indexUrl,
  categoryNames,
  manualRankings,
  scopeCategory,
  gridId,
  noMatchId,
}: CatalogueControlsProps): React.JSX.Element {
  const [docs, setDocs] = useState<SearchDoc[] | null>(null);
  const [index, setIndex] = useState<MiniSearch<SearchDoc> | null>(null);
  const [state, setState] = useState<FilterState>(() => neutralState());
  const [shown, setShown] = useState<number | null>(null);
  const loading = useRef(false);

  /* --- 1. Load the index when the browser is idle ------------------------ */
  useEffect(() => {
    if (loading.current) return;
    loading.current = true;

    const load = (): void => {
      void fetch(indexUrl)
        .then(async (response) => {
          if (!response.ok) throw new Error(`SEARCH_INDEX_HTTP_${response.status}`);
          const all = (await response.json()) as SearchDoc[];
          // On a category route the island must not resurrect a card the server did not render.
          const scoped =
            scopeCategory === undefined ? all : all.filter((doc) => doc.c === scopeCategory);
          setDocs(scoped);
          setIndex(await createIndex(scoped));
        })
        .catch(() => {
          // The prerendered grid stays exactly as it is: unfiltered, Newest, fully usable.
          setDocs(null);
        });
    };

    // `requestIdleCallback` is not in every engine (Safari added it late), so the timeout is the
    // documented fallback rather than an afterthought.
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(load, { timeout: 2000 });
    } else {
      window.setTimeout(load, 200);
    }
  }, [indexUrl, scopeCategory]);

  const vocabulary = useMemo(() => (docs === null ? {} : facetVocabulary(docs)), [docs]);

  /* --- 2. Adopt the URL's state, then rewrite the URL to what was applied - */
  useEffect(() => {
    if (docs === null) return;
    const parsed = parseFilters(window.location.search, vocabulary);
    setState(parsed);
    const canonical = serializeFiltersAsSearch(parsed);
    if (canonical !== window.location.search) {
      // Requirement 3.19: rewrite, do not add a history entry for a correction.
      window.history.replaceState(null, '', `${window.location.pathname}${canonical}`);
    }
  }, [docs, vocabulary]);

  /* --- Back/forward restores the state recorded for the target entry ------ */
  useEffect(() => {
    if (docs === null) return;
    const onPopState = (): void => {
      setState(parseFilters(window.location.search, vocabulary));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [docs, vocabulary]);

  const context = useMemo<SuggestContext | null>(
    () => (docs === null || index === null ? null : { docs, index, categoryNames }),
    [docs, index, categoryNames],
  );

  const ranking = useMemo<RankingContext>(
    // The measured snapshot is a build-time input; the client only ever holds the curated
    // orderings, so a client-side sort can never claim to be measured.
    () => ({ manual: manualRankings, snapshot: null }),
    [manualRankings],
  );

  /* --- 3. Filter, sort, and push the order into the prerendered grid ------ */
  const results = useMemo<SearchDoc[] | null>(() => {
    if (docs === null || context === null) return null;
    return sortDocs(filter(candidatesFor(state.q, context), state), state.sort, ranking);
  }, [docs, context, state, ranking]);

  useEffect(() => {
    if (results === null) return;
    const grid = document.getElementById(gridId);
    if (grid === null) return;
    const count = applyResults(
      grid,
      results.map((doc) => doc.i),
    );
    setShown(count);

    const noMatch = document.getElementById(noMatchId);
    if (noMatch !== null) noMatch.hidden = count > 0;
  }, [results, gridId, noMatchId]);

  const facets = useMemo(
    () => (docs === null ? null : facetCounts(docs, state, categoryNames)),
    [docs, state, categoryNames],
  );

  /* --- 4. Every state change writes the URL ------------------------------- */
  const commit = useCallback((next: FilterState) => {
    setState(next);
    const search = serializeFiltersAsSearch(next);
    window.history.pushState(null, '', `${window.location.pathname}${search}`);
  }, []);

  const onToggle = useCallback(
    (dimension: MultiDimension, value: string) => {
      commit(toggleValue(state, dimension, value));
    },
    [commit, state],
  );

  const onPriceBand = useCallback(
    (priceBand: PriceBandFilter) => {
      commit({ ...state, priceBand });
    },
    [commit, state],
  );

  const onAvailability = useCallback(
    (availability: AvailabilityFilter) => {
      commit({ ...state, availability });
    },
    [commit, state],
  );

  const onSort = useCallback(
    (sort: SortKey) => {
      commit({ ...state, sort });
    },
    [commit, state],
  );

  // Requirement 3.17: one control that removes every filter parameter and keeps the sort.
  const onClear = useCallback(() => {
    commit(clearFilters(state));
  }, [commit, state]);

  if (docs === null || facets === null) {
    // Nothing is claimed while the index is in flight: the prerendered grid is the truth, and a
    // spinner over usable content would be worse than no control at all.
    return <div className="ngf-controls" aria-hidden="true" />;
  }

  return (
    <div className="ngf-controls">
      <div className="ngf-controls-bar">
        <FilterPanel
          facets={facets}
          onToggle={onToggle}
          onPriceBand={onPriceBand}
          onAvailability={onAvailability}
          onClear={onClear}
          hasFilters={!isNeutral(state)}
        />
        <SortControl value={state.sort} onChange={onSort} docs={docs} ranking={ranking} />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {shown === null
          ? ''
          : `${shown} ${shown === 1 ? 'product' : 'products'} shown${
              isNeutral(state) ? '' : ' for the current filters'
            }.`}
      </p>
    </div>
  );
}
