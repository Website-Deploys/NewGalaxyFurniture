/**
 * URL canonicalisation: one 301, never two.
 *
 * Two rules apply to the same request and they compose in one direction only:
 *
 * 1. **Trailing slashes are normalised away.** `/about/` and `/about` are one page, and a page with
 *    two addresses splits its own ranking signals. The form without the slash is canonical because
 *    it is the form `buildPageMeta` emits in `<link rel="canonical">` — the redirect target and the
 *    canonical tag can never disagree, because both come from the same rule.
 * 2. **Renamed slugs redirect to their new address**, from `data/site/redirects.json`, which the
 *    rename path in the write pipeline maintains and collapses chains in (Requirement 12.11).
 *
 * They are resolved together rather than in sequence: the slash is stripped *first*, then the
 * rename map is consulted, so `/product/old-name/` reaches `/product/new-name` in a single hop.
 * Chained redirects cost the visitor a round trip each and browsers give up after about twenty.
 *
 * The map is consulted for the path only; the query string is preserved verbatim, because a
 * campaign parameter on a renamed URL is still a campaign parameter.
 *
 * Requirements: 12.11, 23.15, 23.16.
 */

/** `/a/b/` → `/a/b`, `/` → `/`, `//` → `/`. */
export function normalisePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The single target this request should be 301'd to, or `null` when it is already canonical.
 *
 * Returned as a path plus query so the caller keeps control of the status code and the origin.
 */
export function canonicalRedirect(
  url: Pick<URL, 'pathname' | 'search'>,
  redirects: Readonly<Record<string, string>>,
): string | null {
  const normalised = normalisePath(url.pathname);
  const renamed = redirects[normalised];
  const target = renamed === undefined ? normalised : normalisePath(renamed);
  if (target === url.pathname) return null;
  return `${target}${url.search}`;
}
