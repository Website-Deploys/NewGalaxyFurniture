/**
 * The header search combobox, on every public page.
 *
 * The behaviours that are easy to describe and easy to get wrong, and how each is handled:
 *
 * - **The index is not in the initial payload.** It is fetched on first *intent* — focus, or the
 *   first keystroke — and never on page load (Requirement 22.8). `ensureIndex` is idempotent and
 *   holds a single in-flight promise, so focus-then-type does not fetch twice.
 * - **120 ms debounce, superseded queries discarded** (Requirement 2.7). Discarding is not the
 *   same as debouncing: an index that arrives after the visitor has typed three more characters
 *   must not paint the stale result. A monotonically increasing request id is compared before
 *   any state write.
 * - **Keyboard operation** (Requirement 2.8): ArrowDown/ArrowUp move the active option, Enter
 *   activates it, Escape closes the list while *retaining the typed text and the focus*. The
 *   active option is exposed with `aria-activedescendant` on the input — focus stays in the
 *   textbox throughout, which is what the combobox pattern requires and what makes typing after
 *   arrowing possible.
 * - **A polite live region** announces the number of suggestions, so a screen-reader user learns
 *   that the list changed without focus moving.
 * - **Empty focus shows up to five recent searches** from this device (Requirement 2.9).
 * - **A query with no match is never a dead end** (Requirement 2.10): three nearest matches plus
 *   category shortcuts.
 * - **A failed index fetch retains the typed text**, says search is temporarily unavailable, and
 *   offers category navigation (Requirement 2.14). It does not clear the field or pretend there
 *   are no results.
 *
 * Requirements: 2.1–2.14, 22.8, 24.11.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useScopedId } from '@/lib/ui/ids';
import type MiniSearch from 'minisearch';

import type * as SearchQueryModule from '@/lib/search/query';
import type { Suggestion, SuggestContext } from '@/lib/search/query';
import { current as currentBatcher } from '@/lib/analytics/client';
import Skeleton from '@/components/ui/Skeleton';
import { readRecentSearches, recordRecentSearch } from '@/lib/search/recent';
import { collectionSearchHref } from '@/lib/search/params';
import type { SearchDoc } from '@/lib/search/types';

/**
 * The suggestion engine, loaded on first search intent.
 *
 * `@/lib/search/query` is the folding, edit-distance, ranking and facet-suggestion machinery, and it
 * pulls MiniSearch and the currency formatter with it. None of it is needed until someone types, and
 * a static import put 3.4 kB of it into the eager graph of every page on the site — the search box is
 * part of the shell, so "every page" means the policy pages too. It is imported alongside the index
 * fetch, which the visitor is already waiting on, so nothing is slower for the person who does
 * search and 3.4 kB is not spent on the person who does not.
 */
type SearchEngine = typeof SearchQueryModule;

/** Requirement 2.1 — this string is part of the contract, not a suggestion. */
export const SEARCH_PLACEHOLDER = 'Search by name, SKU, material, colour...';

/** Requirement 2.7. */
export const DEBOUNCE_MS = 120;

export interface SearchBoxCategory {
  slug: string;
  name: string;
}

export interface SearchBoxProps {
  /** `/search-index/{hash}.json`, computed at build time. */
  indexUrl: string;
  /** The nine published categories, for suggestion labels and the shortcut row. */
  categories: readonly SearchBoxCategory[];
  /** `compact` for the mobile header, `full` for desktop. */
  variant?: 'compact' | 'full';
}

type IndexState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; docs: SearchDoc[]; index: MiniSearch<SearchDoc>; engine: SearchEngine }
  | { status: 'error' };

export default function SearchBox({
  indexUrl,
  categories,
  variant = 'full',
}: SearchBoxProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [index, setIndex] = useState<IndexState>({ status: 'idle' });
  const [recent, setRecent] = useState<readonly string[]>([]);
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  /** True when the rows on screen are "nearest matches" rather than actual matches. */
  const [isFallback, setIsFallback] = useState(false);

  // Scoped by `variant`, because both search boxes are mounted on every page: the header's full
  // box and the mobile bar's compact one. Unscoped `useId()` gives them the same value under
  // `preact/compat`, which pointed both `aria-controls` attributes at one listbox — see
  // `@/lib/ui/ids`.
  const listId = useScopedId(`ngf-search-${variant}-list`);
  const optionPrefix = useScopedId(`ngf-search-${variant}`);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const loading = useRef<Promise<void> | null>(null);
  /** Monotonic request id — the mechanism that discards superseded queries. */
  const requestId = useRef(0);

  const categoryNames = useMemo(
    () => Object.fromEntries(categories.map((category) => [category.slug, category.name])),
    [categories],
  );

  /**
   * Memoized: the suggestion effect depends on it, and a fresh object every render would reset
   * the 120 ms debounce on every keystroke's re-render and never fire.
   */
  const context = useMemo<(SuggestContext & { engine: SearchEngine }) | null>(
    () =>
      index.status === 'ready'
        ? { docs: index.docs, index: index.index, categoryNames, engine: index.engine }
        : null,
    [index, categoryNames],
  );

  /**
   * Fetch the index and load the engine once, on first search intent.
   *
   * Both in one promise, in parallel: the module and the data are needed at the same moment, and the
   * engine only enters `IndexState` once both have arrived — so `context` being non-null is the
   * single signal that suggestions can be computed, and no code path can reach the engine before it
   * exists.
   */
  const ensureIndex = useCallback(() => {
    if (loading.current !== null) return;
    setIndex({ status: 'loading' });
    loading.current = Promise.all([
      fetch(indexUrl).then(async (response) => {
        if (!response.ok) throw new Error(`SEARCH_INDEX_HTTP_${response.status}`);
        return (await response.json()) as SearchDoc[];
      }),
      import('@/lib/search/query'),
    ])
      .then(async ([docs, engine]) => {
        setIndex({ status: 'ready', docs, index: await engine.createIndex(docs), engine });
      })
      .catch(() => {
        // Requirement 2.14: no typed text is lost and the visitor is told what happened.
        setIndex({ status: 'error' });
      });
  }, [indexUrl]);

  /* Debounced suggestion computation. */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '' || context === null) {
      setSuggestions([]);
      setIsFallback(false);
      setActiveIndex(-1);
      return;
    }
    const ctx = context;
    requestId.current += 1;
    const id = requestId.current;
    const timer = window.setTimeout(() => {
      // The guard is what makes a superseded query's result unobservable.
      if (id !== requestId.current) return;
      const next = ctx.engine.suggest(trimmed, ctx);
      /**
       * Requirement 2.10's trigger is "matches **no product**", not "matches nothing". A query like
       * `sofa` against an empty catalogue still matches the Sofas *category*, so the list is not
       * empty — but no product matched, so the nearest matches and the category shortcuts are both
       * owed. Basing the fallback on `next.length === 0` would silently skip them.
       */
      const fallback = !next.some((suggestion) => suggestion.kind === 'product');
      setSuggestions(
        fallback
          ? [
              ...ctx.engine.nearestMatches(trimmed, ctx),
              ...next.filter((suggestion) => suggestion.kind !== 'product'),
            ].slice(0, ctx.engine.SUGGESTION_LIMIT)
          : next,
      );
      setIsFallback(fallback);
      setActiveIndex(-1);
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, context]);

  /* Close on an outside pointer press. Escape is handled on the input itself. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onFocus = useCallback(() => {
    ensureIndex();
    setRecent(readRecentSearches());
    setOpen(true);
  }, [ensureIndex]);

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      ensureIndex();
      setQuery(event.target.value);
      setOpen(true);
    },
    [ensureIndex],
  );

  /**
   * Report a search once it is *committed* — a suggestion chosen, or the query submitted — and
   * never per keystroke. A search event is a statement about what someone was looking for, and
   * counting the prefixes of a word would fill the operator's "most frequent searches" with
   * `s`, `so`, `sof`. The result count travels with it so a query that found nothing is
   * distinguishable from one that was never measured (Requirement 20.5).
   */
  const report = useCallback((text: string, results: number) => {
    const trimmed = text.trim();
    if (trimmed !== '') currentBatcher()?.track('search', trimmed, results);
  }, []);

  const commit = useCallback(
    (suggestion: Suggestion) => {
      recordRecentSearch(query);
      report(query, suggestions.length);
      setOpen(false);
      window.location.assign(suggestion.href);
    },
    [query, report, suggestions.length],
  );

  const submit = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed === '') return;
    recordRecentSearch(trimmed);
    report(trimmed, suggestions.length);
    window.location.assign(collectionSearchHref(trimmed));
  }, [query, report, suggestions.length]);

  const options: readonly Suggestion[] = suggestions;

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        // Requirement 2.8: the list closes, the text and the focus stay.
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (options.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActiveIndex((current) => {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = current + delta;
          if (next < 0) return options.length - 1;
          if (next >= options.length) return 0;
          return next;
        });
        return;
      }
      if (event.key === 'Enter') {
        const active = activeIndex >= 0 ? options[activeIndex] : undefined;
        event.preventDefault();
        if (active !== undefined) commit(active);
        else submit();
      }
    },
    [options, activeIndex, commit, submit],
  );

  const trimmed = query.trim();
  const showRecent = open && trimmed === '' && recent.length > 0;
  const showUnavailable = open && index.status === 'error';
  // Requirement 2.10: the nearest matches AND the category shortcuts, together — a query that
  // matched nothing still has two ways forward.
  const showNoMatch = open && trimmed !== '' && index.status === 'ready' && isFallback;
  const listOpen = open && (options.length > 0 || showRecent);

  const announcement =
    index.status === 'error'
      ? 'Search is temporarily unavailable.'
      : trimmed === ''
        ? ''
        : /*
           * The loading sentence lives here, in the existing live region, rather than beside the
           * skeleton. A skeleton says "loading" by its shape, which conveys nothing to a screen
           * reader; this says it in words, once, in the one place that is already announced.
           */
          index.status === 'loading'
          ? 'Loading the catalogue…'
          : options.length === 0
            ? 'No matching products.'
            : `${options.length} ${options.length === 1 ? 'suggestion' : 'suggestions'} available.`;

  return (
    <div
      ref={rootRef}
      className={`ngf-search ngf-search-${variant}`}
      data-open={listOpen ? 'true' : 'false'}
    >
      {/*
        A `label`, not a `div`, and that is load-bearing rather than tidy.

        The field is a collapsed magnifier until it has focus — `.ngf-search-field input` is
        `width: 0` and `:focus-within` expands it, so below 1440 px the only thing on screen is the
        icon. As a `div` there was nothing for a pointer to click: the icon is `aria-hidden` and
        decorative, the input it would open is zero pixels wide, and the visually-hidden label was
        one clipped pixel. Tab reached the field and a mouse could not, which is the wrong way round
        for the site's primary way of finding a product. A `label` focuses its control on click by
        default, so the whole icon and its padding are now the affordance.
      */}
      <label className="ngf-search-field" htmlFor={`${optionPrefix}-input`}>
        <span className="sr-only">Search the catalogue</span>
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </svg>
        <input
          id={`${optionPrefix}-input`}
          ref={inputRef}
          type="search"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          placeholder={SEARCH_PLACEHOLDER}
          value={query}
          onFocus={onFocus}
          onChange={onChange}
          onKeyDown={onKeyDown}
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${optionPrefix}-option-${activeIndex}` : undefined
          }
        />
      </label>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className="ngf-search-popover" hidden={!open}>
        {showRecent && (
          <>
            <p className="ngf-search-heading">Recent searches</p>
            <ul className="ngf-search-recent">
              {recent.map((entry) => (
                <li key={entry}>
                  <a href={collectionSearchHref(entry)}>{entry}</a>
                </li>
              ))}
            </ul>
          </>
        )}

        {index.status === 'loading' && trimmed !== '' && (
          /*
           * Requirement 26.12: a placeholder shaped like the expected content, not a sentence where
           * the results will be. Three rows, each a thumbnail beside two lines, which is the shape a
           * suggestion has — so the dropdown does not resize when the real rows replace them. The
           * live region above says it in words for assistive technology, where a shape says nothing.
           */
          <Skeleton variant="row" count={3} lines={2} ratio="1 / 1" />
        )}

        {showUnavailable && (
          <div className="ngf-search-note">
            <p>Search is temporarily unavailable. Browse by category instead:</p>
            <ul className="ngf-search-shortcuts">
              {categories.map((category) => (
                <li key={category.slug}>
                  <a href={`/collection/${category.slug}`}>{category.name}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showNoMatch && (
          <div className="ngf-search-note">
            {/*
              The copy tracks what is actually on screen. With an empty catalogue there are no
              "closest pieces" to point at, and claiming there are would be a small untruth in the
              one place the visitor is already not finding what they wanted.
            */}
            <p>
              {options.some((suggestion) => suggestion.kind === 'product')
                ? `Nothing matched “${trimmed}”. The closest pieces are listed below — or try a category:`
                : `Nothing matched “${trimmed}”. Try a category:`}
            </p>
            <ul className="ngf-search-shortcuts">
              {categories.map((category) => (
                <li key={category.slug}>
                  <a href={`/collection/${category.slug}`}>{category.name}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/*
          Always rendered so `aria-controls` on the input always resolves to a real element;
          `hidden` rather than conditionally mounted, which also keeps option ids stable.
        */}
        <ul
          className="ngf-search-list"
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          hidden={options.length === 0}
        >
          {options.map((suggestion, position) => (
            <li
              key={`${suggestion.kind}-${suggestion.href}-${suggestion.label}`}
              id={`${optionPrefix}-option-${position}`}
              role="option"
              aria-selected={position === activeIndex}
              className="ngf-search-option"
              data-kind={suggestion.kind}
              data-active={position === activeIndex ? 'true' : 'false'}
            >
              <a
                href={suggestion.href}
                tabIndex={-1}
                onClick={(event) => {
                  event.preventDefault();
                  commit(suggestion);
                }}
              >
                {suggestion.thumb !== undefined && (
                  <img
                    src={suggestion.thumb.src}
                    alt=""
                    width={40}
                    height={40}
                    loading="lazy"
                    decoding="async"
                    style={
                      suggestion.thumb.lqip === ''
                        ? undefined
                        : { backgroundImage: `url(${suggestion.thumb.lqip})` }
                    }
                  />
                )}
                <span className="ngf-search-option-text">
                  <span className="ngf-search-option-label">{suggestion.label}</span>
                  {suggestion.sublabel !== undefined && (
                    <span className="ngf-search-option-sub">{suggestion.sublabel}</span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
