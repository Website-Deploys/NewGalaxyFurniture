/**
 * The sitemap document, as pure functions.
 *
 * Separate from `src/pages/sitemap.xml.ts` for one reason: that route reads the content
 * collections, which means importing it drags `astro:content` in, which means the rendering rules —
 * the escaping, the `lastmod` policy, the static-page list — could only be tested by standing up a
 * content collection. Here they are ordinary functions over ordinary data, and the route is a thin
 * wrapper that supplies the data.
 *
 * Design: SEO and Structured Data → URLs, sitemap, robots.
 * Requirements: 23.12, 23.13, 23.15.
 */

import { absoluteUrl } from './meta';

export interface SitemapEntry {
  path: string;
  /** Absent where nothing knows when the page last changed. Never fabricated. */
  lastmod?: string;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority: string;
}

/**
 * Every public static page.
 *
 * Deliberately hand-maintained rather than discovered from the filesystem: `/404` and `/admin/**`
 * are routes too, so a discovered list would need a deny list — and a deny list is the thing that
 * rots. Adding a public page is one line here, and `scripts/audit-seo.ts` fails the build if a built
 * indexable page is missing from the sitemap, so the omission cannot ship.
 */
export const STATIC_SITEMAP_PATHS: readonly string[] = [
  '/',
  '/collection',
  '/custom-furniture',
  '/about',
  '/workshop',
  '/gallery',
  '/reviews',
  '/contact',
  '/faq',
  '/privacy',
  '/terms',
  '/shipping',
  '/returns',
  '/warranty',
];

const POLICY_PATHS = ['/privacy', '/terms', '/shipping', '/returns', '/warranty'];

/** Policy and legal pages change rarely; the catalogue changes with the content. */
export function staticEntry(path: string): SitemapEntry {
  if (path === '/') return { path, changefreq: 'weekly', priority: '1.0' };
  if (path === '/collection') return { path, changefreq: 'daily', priority: '0.9' };
  const policy = POLICY_PATHS.includes(path);
  return { path, changefreq: policy ? 'yearly' : 'monthly', priority: policy ? '0.3' : '0.6' };
}

/** The date part of an ISO timestamp — the granularity `lastmod` is read at. */
export function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** `&`, `<` and `>` in a URL would make the document malformed rather than merely wrong. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderSitemap(entries: readonly SitemapEntry[], siteUrl: string): string {
  const urls = entries
    .map((entry) => {
      const lines = [`    <loc>${xmlEscape(absoluteUrl(siteUrl, entry.path))}</loc>`];
      if (entry.lastmod !== undefined) lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
      lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
      lines.push(`    <priority>${entry.priority}</priority>`);
      return `  <url>\n${lines.join('\n')}\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
