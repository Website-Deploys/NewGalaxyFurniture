/**
 * The `robots.txt` document, as a pure function.
 *
 * Allows everything except three things, each for a different reason:
 *
 * - **`/admin`** — an authenticated application. Crawling it produces nothing but login pages, and
 *   listing it invites attention it has no reason to attract.
 * - **`/api`** — endpoints, not documents. Every one of them already answers with
 *   `X-Robots-Tag: noindex`; this saves the request.
 * - **the 2000 px derivatives** (`/img/{product}/{image}-2000.*`, matched as a wildcard pattern
 *   below) — they exist for the gallery zoom, and a crawler
 *   fetching the largest variant of every photograph is the single most expensive thing that can
 *   happen to this site's bandwidth for no indexing benefit. The smaller derivatives stay
 *   crawlable, so image search still has something to index (Requirement 23.14).
 *
 * `Disallow` is not a security control and is not used as one here — `/admin` is gated by session
 * in `src/middleware.ts` regardless of what any crawler chooses to read.
 *
 * Separate from the route so it can be asserted without an Astro render context.
 *
 * Design: SEO and Structured Data → URLs, sitemap, robots.
 * Requirements: 23.13, 23.14.
 */

import { absoluteUrl } from './meta';

export const DISALLOWED_PATHS: readonly string[] = ['/admin', '/api', '/img/*/*-2000.*'];

export function renderRobots(siteUrl: string): string {
  return [
    'User-agent: *',
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl(siteUrl, '/sitemap.xml')}`,
    '',
  ].join('\n');
}
