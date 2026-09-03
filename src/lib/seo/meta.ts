/**
 * `buildPageMeta` — the only way any page emits metadata.
 *
 * Every public route, the 404, the admin shell, and the preview route pass through this one
 * function. That is not tidiness for its own sake: the three metadata defects that actually ship
 * are a duplicated title, a canonical pointing at the wrong origin, and a preview page that
 * forgot `noindex`. All three are "one page did it differently" defects, and the only structural
 * cure is that there is no other way to do it. `BaseLayout` and `AdminLayout` accept a `PageMeta`
 * and nothing else — no `title` prop, no `description` prop — so a page cannot hand-write a tag.
 *
 * **The hostname appears exactly once in the deployment, in `PUBLIC_SITE_URL`.** It is passed in
 * as `input.siteUrl` rather than read here, which keeps this module pure and testable and keeps
 * the resolution (and its failure mode) in `./site-url.ts`. A unit test asserts no hostname
 * literal exists anywhere under `src/`.
 *
 * **The length bounds are enforced, not documented.** A title is ≤ 60 characters *including* the
 * suffix and a description is ≤ 155, because those are the widths a search result actually
 * renders; a longer one is not "slightly long", it is truncated by someone else at a point we did
 * not choose. Over-long input is cut at a word boundary here, so the cut is ours.
 *
 * **Deviation from the design's template, semantics unchanged.** The design writes the product
 * title fallback as `` `${name} — ${category} | ${titleSuffix}` ``. Taken literally that emits two
 * separators, because `SiteSettings.seoDefaults.titleSuffix` is itself `" | New Galaxy Furniture"`
 * — the separator is part of the stored suffix. `productTitleFallback` therefore composes
 * `` `${name} — ${category}` `` and lets the shared suffix rule append the suffix once, which
 * produces the intended `Name — Category | New Galaxy Furniture`.
 *
 * Design: SEO and Structured Data → Metadata.
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.15, 23.18.
 */

import type { SiteSettings } from '@/schemas/site';

/** The width a search result renders a title at. Includes the site suffix. */
export const TITLE_MAX = 60;
/** The width a search result renders a description at. */
export const DESCRIPTION_MAX = 155;

/** The one robots directive for everything that must never be indexed. */
export const NOINDEX = 'noindex, nofollow';

export type OgType = 'website' | 'product' | 'article';

export interface OgImage {
  /** Absolute after `buildPageMeta`; may be site-relative on the way in. */
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface PageMeta {
  /** ≤ 60 chars incl. suffix. */
  title: string;
  /** ≤ 155 chars. */
  description: string;
  /** Absolute, from `PUBLIC_SITE_URL`. */
  canonical: string;
  robots?: string;
  og: {
    type: OgType;
    title: string;
    description: string;
    url: string;
    siteName: string;
    image?: OgImage;
  };
  twitter: { card: 'summary_large_image' };
  jsonLd: object[];
}

export interface PageMetaInput {
  /** The deployment origin, from `PUBLIC_SITE_URL`. The only source of the hostname. */
  siteUrl: string;
  /** Site-relative path with a leading slash, e.g. `/product/luxury-l-shape-sofa`. */
  path: string;
  /** The page's own title, without the site suffix. The suffix is appended here. */
  title: string;
  description?: string;
  ogType?: OgType;
  /** Site-relative or absolute; absolutised against `siteUrl`. */
  ogImage?: OgImage;
  /** `/admin/**`, previews, and anything else that must stay out of an index. */
  noindex?: boolean;
  /** An explicit directive. Wins over `noindex`. */
  robots?: string;
  jsonLd?: readonly object[];
}

/**
 * Cut `text` to at most `max` characters at a word boundary.
 *
 * No ellipsis: the design specifies "the first 155 characters of the description at a word
 * boundary", and an ellipsis would either break that count or spend a character saying something
 * the reader can already see. Trailing punctuation left dangling by the cut is removed, so a
 * description never ends on a comma or an opening bracket.
 */
export function truncateAtWord(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;

  const window = collapsed.slice(0, max + 1);
  const lastSpace = window.lastIndexOf(' ');
  // A single word longer than the budget has no boundary to cut at; a hard cut is the only
  // total answer, and it still satisfies the bound.
  const cut = lastSpace <= 0 ? collapsed.slice(0, max) : collapsed.slice(0, lastSpace);
  return cut.replace(/[\s,;:.\-—–([{'"]+$/u, '').trim();
}

/**
 * `title` with the site suffix, held to `TITLE_MAX`.
 *
 * The suffix is never dropped — it is the brand, and a search result without it is a worse
 * result than a shortened one. So when the pair does not fit, the *page's* part is shortened.
 */
export function withTitleSuffix(title: string, suffix: string, max = TITLE_MAX): string {
  const own = title.replace(/\s+/g, ' ').trim();
  const tail = suffix.trim() === '' ? '' : suffix;
  if (own.endsWith(tail.trim()) && tail !== '') return truncateAtWord(own, max);

  const room = max - tail.length;
  // A suffix that leaves no room at all: the suffix alone is the honest answer.
  if (room <= 0) return truncateAtWord(tail, max);
  return `${truncateAtWord(own, room)}${tail}`;
}

/** `path` (or an already-absolute URL) as an absolute URL on `siteUrl`. */
export function absoluteUrl(siteUrl: string, path: string): string {
  const origin = siteUrl.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * The canonical form of a path: absolute, no trailing slash (except the root), no query, no
 * fragment. The trailing-slash rule is the same one the edge 301s to, so a canonical tag can
 * never disagree with the URL the visitor was redirected to.
 */
export function canonicalUrl(siteUrl: string, path: string): string {
  const [withoutFragment = ''] = path.split('#');
  const [pathOnly = ''] = withoutFragment.split('?');
  const trimmed = pathOnly.replace(/\/+$/, '');
  return absoluteUrl(siteUrl, trimmed === '' ? '/' : trimmed);
}

/**
 * The product title fallback chain: `seoTitle` → `` `${name} — ${category}` `` (+ suffix).
 *
 * The category name is included because two products in different categories frequently share a
 * name ("Queen Bed"), and a duplicated title is the defect this chain exists to avoid. When the
 * category is unknown the name alone is used rather than the slug — a slug in a title is a leaked
 * implementation detail.
 */
export function productTitleFallback(
  product: { seoTitle?: string; name: string },
  categoryName?: string,
): string {
  if (product.seoTitle !== undefined && product.seoTitle.trim() !== '') return product.seoTitle;
  const category = categoryName?.trim();
  return category === undefined || category === '' ? product.name : `${product.name} — ${category}`;
}

/**
 * The product description fallback chain: `seoDescription` → `shortDescription` → the description
 * truncated at a word boundary.
 *
 * Every branch is truncated, not just the last: `seoDescription` is schema-capped at 170
 * characters, which is longer than a search result renders, so an operator-authored value can
 * exceed the bound too.
 */
export function productDescriptionFallback(product: {
  seoDescription?: string;
  shortDescription?: string;
  description: string;
}): string {
  const candidate =
    product.seoDescription !== undefined && product.seoDescription.trim() !== ''
      ? product.seoDescription
      : product.shortDescription !== undefined && product.shortDescription.trim() !== ''
        ? product.shortDescription
        : product.description;
  return truncateAtWord(candidate, DESCRIPTION_MAX);
}

/**
 * The single metadata path.
 *
 * `site` supplies the two shared values — the title suffix and the default description — so a
 * page that has nothing specific to say still says something true rather than nothing.
 */
export function buildPageMeta(input: PageMetaInput, site: SiteSettings): PageMeta {
  const title = withTitleSuffix(input.title, site.seoDefaults.titleSuffix);
  const description = truncateAtWord(
    input.description !== undefined && input.description.trim() !== ''
      ? input.description
      : site.seoDefaults.description,
    DESCRIPTION_MAX,
  );
  const canonical = canonicalUrl(input.siteUrl, input.path);
  const robots = input.robots ?? (input.noindex === true ? NOINDEX : undefined);

  const image =
    input.ogImage === undefined
      ? undefined
      : { ...input.ogImage, url: absoluteUrl(input.siteUrl, input.ogImage.url) };

  return {
    title,
    description,
    canonical,
    ...(robots === undefined ? {} : { robots }),
    og: {
      type: input.ogType ?? 'website',
      title,
      description,
      url: canonical,
      siteName: site.businessName,
      ...(image === undefined ? {} : { image }),
    },
    twitter: { card: 'summary_large_image' },
    jsonLd: [...(input.jsonLd ?? [])],
  };
}

/**
 * A JSON-LD payload as the text of a `<script type="application/ld+json">`.
 *
 * `<` is escaped so no string in the data — a product description, an operator-written note —
 * can close the element early and turn content into markup. This is the only serialiser any
 * surface uses for structured data.
 */
export function jsonLdText(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
