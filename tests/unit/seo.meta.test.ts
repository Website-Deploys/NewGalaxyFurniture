import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  absoluteUrl,
  buildPageMeta,
  canonicalUrl,
  DESCRIPTION_MAX,
  jsonLdText,
  NOINDEX,
  productDescriptionFallback,
  productTitleFallback,
  TITLE_MAX,
  truncateAtWord,
  withTitleSuffix,
} from '@/lib/seo/meta';
import { canonicalRedirect, normalisePath } from '@/lib/seo/redirects';
import { DISALLOWED_PATHS, renderRobots } from '@/lib/seo/robots';
import { renderSitemap, STATIC_SITEMAP_PATHS } from '@/lib/seo/sitemap';
import type { SiteSettings } from '@/schemas/site';

/**
 * The metadata layer.
 *
 * Two kinds of assertion here, and the second is the one that will still be earning its keep in a
 * year: the first checks that `buildPageMeta` honours the bounds and the fallback chains, and the
 * second reads every file under `src/` and asserts that no hostname literal exists anywhere in it.
 * That is the check that keeps "attaching the purchased domain is one environment variable" true —
 * a single hard-coded origin in one page is enough to break it, and it would break it silently.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.5, 23.6, 23.12, 23.13, 23.15, 23.16, 28.9.
 */

const SITE: SiteSettings = {
  businessName: 'New Galaxy Furniture',
  logo: { src: null, wordmarkFallback: 'NEW GALAXY FURNITURE', width: null, height: null },
  whatsapp: [{ label: 'Orders 1', e164: '+919513443606' }],
  phone: [{ label: 'Orders 1', e164: '+919513443606' }],
  location: {
    addressLines: [],
    city: '',
    state: '',
    postalCode: null,
    mapUrl: null,
    geo: null,
  },
  serviceArea: ['Karnataka'],
  social: {},
  seoDefaults: {
    titleSuffix: ' | New Galaxy Furniture',
    description: 'A catalogue of furniture made to order.',
    ogImageKey: null,
  },
  placeholders: [],
};

const ORIGIN = 'https://example.test';

describe('truncateAtWord', () => {
  it('is the identity below the bound and never exceeds it', () => {
    expect(truncateAtWord('a short line', 40)).toBe('a short line');
    expect(truncateAtWord('x'.repeat(200), 60)).toHaveLength(60);
  });

  it('cuts at a word boundary and leaves no dangling punctuation', () => {
    const cut = truncateAtWord('Seasoned hardwood frame, fabric upholstery, made to order', 30);
    expect(cut.length).toBeLessThanOrEqual(30);
    expect(cut.endsWith(',')).toBe(false);
    expect(cut.split(' ').at(-1)).not.toBe('');
    // No word is chopped in half.
    expect('Seasoned hardwood frame, fabric upholstery, made to order').toContain(cut);
  });

  it('collapses runs of whitespace so a measured length is the rendered length', () => {
    expect(truncateAtWord('two   spaces\n\nand a newline', 100)).toBe('two spaces and a newline');
  });
});

describe('withTitleSuffix', () => {
  it('appends the suffix once and never twice', () => {
    expect(withTitleSuffix('About', ' | New Galaxy Furniture')).toBe(
      'About | New Galaxy Furniture',
    );
    expect(withTitleSuffix('About | New Galaxy Furniture', ' | New Galaxy Furniture')).toBe(
      'About | New Galaxy Furniture',
    );
  });

  it('shortens the page part rather than dropping the brand when the pair will not fit', () => {
    const suffix = ' | New Galaxy Furniture';
    const title = withTitleSuffix(
      'An Extremely Long Product Name That Will Not Fit In Sixty Characters',
      suffix,
    );
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith(suffix)).toBe(true);
  });
});

describe('buildPageMeta', () => {
  it('holds the title to 60 characters including the suffix', () => {
    const meta = buildPageMeta({ siteUrl: ORIGIN, path: '/x', title: 'y'.repeat(120) }, SITE);
    expect(meta.title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it('holds the description to 155 characters', () => {
    const meta = buildPageMeta(
      { siteUrl: ORIGIN, path: '/x', title: 'Page', description: 'word '.repeat(80) },
      SITE,
    );
    expect(meta.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it('falls back to the site description rather than emitting an empty one', () => {
    const meta = buildPageMeta({ siteUrl: ORIGIN, path: '/x', title: 'Page' }, SITE);
    expect(meta.description).toBe(SITE.seoDefaults.description);
  });

  it('produces an absolute canonical on the configured origin, with no trailing slash', () => {
    expect(buildPageMeta({ siteUrl: ORIGIN, path: '/about/', title: 'A' }, SITE).canonical).toBe(
      `${ORIGIN}/about`,
    );
    expect(buildPageMeta({ siteUrl: ORIGIN, path: '/', title: 'A' }, SITE).canonical).toBe(
      `${ORIGIN}/`,
    );
  });

  it('drops the query and fragment from the canonical', () => {
    const meta = buildPageMeta(
      { siteUrl: ORIGIN, path: '/collection?q=sofa#results', title: 'C' },
      SITE,
    );
    expect(meta.canonical).toBe(`${ORIGIN}/collection`);
  });

  it('emits no robots directive by default and noindex, nofollow when asked', () => {
    expect(buildPageMeta({ siteUrl: ORIGIN, path: '/a', title: 'A' }, SITE).robots).toBeUndefined();
    expect(
      buildPageMeta({ siteUrl: ORIGIN, path: '/a', title: 'A', noindex: true }, SITE).robots,
    ).toBe(NOINDEX);
  });

  it('mirrors the title and description into the social preview and absolutises its image', () => {
    const meta = buildPageMeta(
      {
        siteUrl: ORIGIN,
        path: '/product/sofa',
        title: 'Sofa',
        description: 'A sofa.',
        ogType: 'product',
        ogImage: { url: '/img/p_1/img_1-1200.webp', alt: 'A sofa' },
      },
      SITE,
    );
    expect(meta.og.type).toBe('product');
    expect(meta.og.title).toBe(meta.title);
    expect(meta.og.description).toBe(meta.description);
    expect(meta.og.url).toBe(meta.canonical);
    expect(meta.og.image?.url).toBe(`${ORIGIN}/img/p_1/img_1-1200.webp`);
    expect(meta.twitter.card).toBe('summary_large_image');
  });
});

describe('product metadata fallback chains', () => {
  const base = {
    name: 'Luxury L-Shape Sofa',
    description:
      'A generously proportioned L-shape sofa built on a seasoned hardwood frame, upholstered in a hard-wearing weave, and made to the length your room actually needs rather than a standard size.',
  };

  it('prefers seoTitle, then name — category', () => {
    expect(productTitleFallback({ ...base, seoTitle: 'Chosen Title' }, 'Sofas')).toBe(
      'Chosen Title',
    );
    expect(productTitleFallback(base, 'Sofas')).toBe('Luxury L-Shape Sofa — Sofas');
  });

  it('uses the name alone rather than leaking a category slug when the name is unknown', () => {
    expect(productTitleFallback(base, undefined)).toBe('Luxury L-Shape Sofa');
    expect(productTitleFallback(base, '   ')).toBe('Luxury L-Shape Sofa');
  });

  it('prefers seoDescription, then shortDescription, then the description at a word boundary', () => {
    expect(productDescriptionFallback({ ...base, seoDescription: 'Chosen.' })).toBe('Chosen.');
    expect(productDescriptionFallback({ ...base, shortDescription: 'A short one.' })).toBe(
      'A short one.',
    );

    const fromDescription = productDescriptionFallback(base);
    expect(fromDescription.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(base.description).toContain(fromDescription);
  });

  it('truncates an operator-authored seoDescription too, since the schema allows 170 characters', () => {
    const long = 'word '.repeat(50).trim();
    expect(
      productDescriptionFallback({ ...base, seoDescription: long }).length,
    ).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });
});

describe('jsonLdText', () => {
  it('escapes the characters that could close the script element early', () => {
    const text = jsonLdText({ name: '</script><script>alert(1)</script>' });
    expect(text).not.toContain('</script');
    expect(text).not.toContain('<script');
    expect(JSON.parse(text)).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});

describe('canonical redirects', () => {
  it('strips a trailing slash and leaves the root alone', () => {
    expect(normalisePath('/about/')).toBe('/about');
    expect(normalisePath('/')).toBe('/');
    expect(canonicalRedirect({ pathname: '/about/', search: '' }, {})).toBe('/about');
    expect(canonicalRedirect({ pathname: '/about', search: '' }, {})).toBeNull();
    expect(canonicalRedirect({ pathname: '/', search: '' }, {})).toBeNull();
  });

  it('reaches a renamed slug in one hop, even from the trailing-slash form', () => {
    const map = { '/product/old-name': '/product/new-name' };
    expect(canonicalRedirect({ pathname: '/product/old-name', search: '' }, map)).toBe(
      '/product/new-name',
    );
    expect(canonicalRedirect({ pathname: '/product/old-name/', search: '' }, map)).toBe(
      '/product/new-name',
    );
  });

  it('preserves the query string', () => {
    expect(canonicalRedirect({ pathname: '/collection/', search: '?q=sofa' }, {})).toBe(
      '/collection?q=sofa',
    );
  });
});

describe('robots.txt', () => {
  it('disallows admin, api and the 2000 px derivatives, and points at the sitemap', () => {
    const body = renderRobots(ORIGIN);
    expect(DISALLOWED_PATHS).toEqual(['/admin', '/api', '/img/*/*-2000.*']);
    for (const path of DISALLOWED_PATHS) expect(body).toContain(`Disallow: ${path}`);
    expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    // The smaller derivatives stay crawlable, so image search still has something to index: the
    // only `/img` rule is the one naming the 2000 px variant.
    const imageRules = body.split('\n').filter((line) => line.startsWith('Disallow: /img'));
    expect(imageRules).toEqual(['Disallow: /img/*/*-2000.*']);
  });
});

describe('sitemap.xml', () => {
  it('lists no admin, api, or 404 route', () => {
    for (const path of STATIC_SITEMAP_PATHS) {
      expect(path.startsWith('/admin')).toBe(false);
      expect(path.startsWith('/api')).toBe(false);
      expect(path).not.toBe('/404');
    }
  });

  it('renders absolute locations and a lastmod only where one is known', () => {
    const xml = renderSitemap(
      [
        { path: '/', changefreq: 'weekly', priority: '1.0' },
        {
          path: '/product/sofa',
          lastmod: '2026-02-01',
          changefreq: 'monthly',
          priority: '0.7',
        },
      ],
      ORIGIN,
    );
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/product/sofa</loc>`);
    expect(xml).toContain('<lastmod>2026-02-01</lastmod>');
    // Exactly one lastmod: the category and static rows carry none rather than a fabricated one.
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });
});

describe('absoluteUrl', () => {
  it('joins with exactly one separator and passes an absolute URL through', () => {
    expect(absoluteUrl('https://a.test/', '/b')).toBe('https://a.test/b');
    expect(absoluteUrl('https://a.test', 'b')).toBe('https://a.test/b');
    expect(absoluteUrl('https://a.test', 'https://b.test/c')).toBe('https://b.test/c');
    expect(canonicalUrl('https://a.test', '')).toBe('https://a.test/');
  });
});

/* -------------------------------------------------------------------------- */
/* No hostname anywhere under src/                                            */
/* -------------------------------------------------------------------------- */

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Hosts that are not site configuration, and why each is allowed.
 *
 * `schema.org` and `www.w3.org` are vocabulary URIs — identifiers whose meaning *is* the string, so
 * making them configurable would make the structured data mean something else. The four API hosts
 * are upstream endpoints that receive a credential (`GITHUB_TOKEN`, `CF_API_TOKEN`, `AI_API_KEY`),
 * and a host read from configuration would turn a settings edit into a way to send a secret
 * somewhere else. `localhost` and `127.0.0.1` are development only. The eslint rule
 * `no-restricted-syntax` carries the identical list; this test is the second lock, because a lint
 * rule can be disabled inline.
 */
const ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  'schema.org',
  'www.w3.org',
  'api.github.com',
  'api.cloudflare.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.whatsapp.com',
  'wa.me',
  // The sitemap protocol namespace. Like schema.org, the string *is* the identifier.
  'www.sitemaps.org',
];

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.css', '.js', '.mjs', '.json']);

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (TEXT_EXTENSIONS.has(extname(entry))) found.push(full);
  }
  return found;
}

describe('the domain appears only in PUBLIC_SITE_URL', () => {
  it('finds no hostname literal anywhere under src/', () => {
    const offenders: string[] = [];

    for (const file of filesUnder(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = (match[1] ?? '').toLowerCase();
        if (ALLOWED_HOSTS.includes(host)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(SRC, file)}:${String(line)} → ${match[0]}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('reads the site URL variable in exactly two resolvers', () => {
    /*
     * *Reads*, not mentions: several files name `PUBLIC_SITE_URL` in a comment to say where their
     * origin comes from, which is documentation rather than a second resolution path. What matters
     * is how many places actually pull the value out of the environment, because each one is a place
     * that could normalise it differently — a trailing slash in one and not the other is how a
     * canonical tag ends up disagreeing with a redirect target.
     */
    const readers = filesUnder(SRC)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          /\benv(?:ironment)?\.PUBLIC_SITE_URL\b/.test(text) ||
          /import\.meta\.env(?: as [^)]*\))?\.PUBLIC_SITE_URL/.test(text) ||
          /\bbuildTime\.PUBLIC_SITE_URL\b/.test(text) ||
          /PUBLIC_SITE_URL\?:/.test(text)
        );
      })
      .map((file) => relative(SRC, file))
      .sort();

    // `lib/env.ts` for the Worker's public config and `lib/seo/site-url.ts` for rendering.
    expect(readers).toEqual(['lib/env.ts', 'lib/seo/site-url.ts']);
  });
});
