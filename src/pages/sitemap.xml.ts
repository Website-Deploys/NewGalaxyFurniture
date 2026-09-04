/**
 * `sitemap.xml`, generated at build from the published collections.
 *
 * **Drafts are absent because they are absent from the build.** This route folds over
 * `getCatalogue()` and `getPublishedCategories()` — the same two readers every public surface uses —
 * so a `DRAFT`, `REVIEW`, or `UNPUBLISHED` product cannot appear here for the same structural reason
 * it has no page: the filter lives in one place and this is downstream of it (Requirement 23.12).
 * There is no allow/deny list to keep in step.
 *
 * `lastmod` is the product's own `updatedAt`, which is the moment the content changed rather than the
 * moment the site was rebuilt — so a deploy that touches nothing does not tell every crawler that
 * everything changed. Categories carry no `updatedAt`, and a fabricated one would be worse than
 * none, so their entries omit `lastmod` entirely.
 *
 * The rendering rules live in `@/lib/seo/sitemap`, which is testable without a content collection.
 * This file is only the data.
 *
 * Design: SEO and Structured Data → URLs, sitemap, robots.
 * Requirements: 23.12, 23.13, 23.15.
 */

import { getCatalogue, getPublishedCategories } from '@/lib/content/catalogue';
import {
  isoDate,
  renderSitemap,
  staticEntry,
  STATIC_SITEMAP_PATHS,
  type SitemapEntry,
} from '@/lib/seo/sitemap';
import { resolveSiteUrl } from '@/lib/seo/site-url';
import type { APIContext } from 'astro';

/** The entries, in a stable order: static pages, then categories, then products. */
export async function sitemapEntries(): Promise<SitemapEntry[]> {
  const [products, categories] = await Promise.all([getCatalogue(), getPublishedCategories()]);

  return [
    ...STATIC_SITEMAP_PATHS.map(staticEntry),
    ...categories.map((category): SitemapEntry => ({
      path: `/collection/${category.slug}`,
      changefreq: 'weekly',
      priority: '0.8',
    })),
    ...products.map((product): SitemapEntry => ({
      path: `/product/${product.slug}`,
      lastmod: isoDate(product.updatedAt),
      changefreq: 'monthly',
      priority: '0.7',
    })),
  ];
}

export async function GET(context: APIContext): Promise<Response> {
  const body = renderSitemap(await sitemapEntries(), resolveSiteUrl(context.site ?? null));
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
