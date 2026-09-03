/**
 * Recent searches — five entries, on the visitor's own device.
 *
 * `localStorage` and nothing else: no account, no cookie, no server-side record (Requirement
 * 2.9 says "retained on the visitor's own device", and the same privacy stance governs recently
 * viewed products). A visitor who clears their browser data has cleared this.
 *
 * "At most five **distinct** entries, most recent first" (Requirement 2.13) means re-searching
 * something already in the list moves it to the front rather than adding a duplicate — the same
 * ring-buffer discipline the recently-viewed list uses.
 *
 * Every function is defensive about storage being unavailable (private mode, quota, a disabled
 * setting) and degrades to "no recent searches" rather than throwing inside a keystroke handler.
 *
 * Requirements: 2.9, 2.13.
 */

export const RECENT_SEARCH_KEY = 'ngf:recent-searches';
export const RECENT_SEARCH_LIMIT = 5;

/** Distinctness is case-insensitive: `Sofa` and `sofa` are the same search. */
function sameSearch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRecentSearches(): string[] {
  const store = storage();
  if (store === null) return [];
  try {
    const raw = store.getItem(RECENT_SEARCH_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    // A corrupt value is not worth reporting to the visitor; it is worth not crashing over.
    return [];
  }
}

/** Pure, so the ordering rule is testable without a DOM. */
export function withRecentSearch(existing: readonly string[], query: string): string[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...existing];
  return [trimmed, ...existing.filter((entry) => !sameSearch(entry, trimmed))].slice(
    0,
    RECENT_SEARCH_LIMIT,
  );
}

export function recordRecentSearch(query: string): string[] {
  const next = withRecentSearch(readRecentSearches(), query);
  const store = storage();
  if (store !== null) {
    try {
      store.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
    } catch {
      // Quota or a blocked store: the list simply does not persist this time.
    }
  }
  return next;
}

export function clearRecentSearches(): void {
  try {
    storage()?.removeItem(RECENT_SEARCH_KEY);
  } catch {
    // Nothing to do — the list is already effectively empty.
  }
}
