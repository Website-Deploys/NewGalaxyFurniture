/**
 * `pageMeta` — the call every route makes.
 *
 * `buildPageMeta` is pure: it takes an origin and the site settings and returns a `PageMeta`. That
 * purity is what makes it testable, and it is also three lines of ceremony at eighteen call sites.
 * This wrapper supplies the two values that are the same on every page — the origin from
 * `PUBLIC_SITE_URL` and the loaded `SiteSettings` — and defaults the path to the route's own
 * pathname, which is the correct canonical for every page that is not deliberately canonicalising
 * elsewhere.
 *
 * It is a wrapper, not a second path: it calls `buildPageMeta` and adds nothing. A page still
 * cannot express a title longer than the bound or a canonical on another origin.
 *
 * Requirements: 23.1, 23.3.
 */

import { getSiteSettings } from '@/lib/content/site';

import { buildPageMeta } from './meta';
import type { PageMeta, PageMetaInput } from './meta';
import { resolveSiteUrl } from './site-url';

/** The two fields of the `Astro` global this needs. Narrow on purpose, so it is trivial to fake. */
export interface RenderContext {
  site?: URL | undefined;
  url: URL;
}

export type PageMetaArgs = Omit<PageMetaInput, 'siteUrl' | 'path'> & {
  /** Defaults to the current route's pathname. */
  path?: string;
};

export function pageMeta(context: RenderContext, input: PageMetaArgs): PageMeta {
  const siteUrl = resolveSiteUrl(context.site ?? null);
  const { path = context.url.pathname, ...rest } = input;
  return buildPageMeta({ ...rest, siteUrl, path }, getSiteSettings());
}

/** The origin, for pages that need it to absolutise an image or a JSON-LD URL. */
export function siteOrigin(context: RenderContext): string {
  return resolveSiteUrl(context.site ?? null);
}
