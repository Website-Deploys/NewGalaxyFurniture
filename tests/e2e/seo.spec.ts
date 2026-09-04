import { expect, test } from '@playwright/test';

import {
  ADMIN_PAGES,
  CATEGORY_SLUGS,
  FIXTURES,
  PUBLIC_PAGES,
  PUBLISHED_FIXTURE_COUNT,
  jsonLdTypes,
  metaContent,
} from './helpers';

/**
 * The SEO assertions.
 *
 * These are the claims a search engine — and therefore a customer looking for a sofa — actually
 * sees. Each one is checked against the served page rather than the source that produced it,
 * because the failure mode being guarded against is a page that renders correctly and describes
 * itself wrongly.
 *
 * The catalogue ships empty, which changes what can be asserted and not whether it should be: the
 * sitemap contains no `/product/*` entry because no product is published, and the `ItemList` on
 * `/collection` is empty. Both are correct, and both are asserted as such — an `ItemList` that
 * listed something today would be the defect.
 *
 * Requirements: 23.1, 23.2, 23.4, 23.7, 23.9, 23.11, 23.12, 23.13, 23.14, 23.15, 23.16.
 * Design: Testing Strategy → Cross-cutting checklists (SEO).
 */

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 155;

/**
 * The origin the deployment is configured to advertise, read from the site itself.
 *
 * Not the harness's `baseURL`. `PUBLIC_SITE_URL` is the single value that carries the domain, it is
 * baked into every canonical at build time, and it must be the *deployment's* origin — a canonical
 * pointing at `localhost` would be the defect. So the invariant worth asserting is not "canonicals
 * match the host I fetched from" but "one configured origin is applied everywhere, consistently":
 * canonicals, `og:url`, the sitemap's every `<loc>`, and `robots.txt`'s `Sitemap:` line must all
 * agree. `robots.txt` is the cheapest place to read it from, and it comes from the same resolver.
 */
async function configuredOrigin(request: {
  get: (url: string) => Promise<{ text: () => Promise<string> }>;
}): Promise<string> {
  const body = await (await request.get('/robots.txt')).text();
  const match = /^Sitemap:\s*(\S+)$/m.exec(body);
  if (match?.[1] === undefined) throw new Error('robots.txt advertises no sitemap');
  return new URL(match[1]).origin;
}

test('every page has a unique title and description, within the length bounds', async ({
  page,
  request,
}) => {
  const origin = await configuredOrigin(request);

  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();

  for (const path of PUBLIC_PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });

    const title = await page.title();
    expect(title, `${path} has no title`).not.toBe('');
    expect(
      title.length,
      `${path} title is ${String(title.length)} chars: ${title}`,
    ).toBeLessThanOrEqual(TITLE_MAX);
    const clashingTitle = titles.get(title);
    expect(clashingTitle, `${path} repeats the title of ${String(clashingTitle)}`).toBeUndefined();
    titles.set(title, path);

    const description = await metaContent(page, 'description');
    expect(description, `${path} has no meta description`).toBeTruthy();
    const text = String(description);
    expect(text.length, `${path} description is ${String(text.length)} chars`).toBeLessThanOrEqual(
      DESCRIPTION_MAX,
    );
    // A floor, not a target: a description this short is a blank or a stub rather than a summary.
    // The upper bound is the one the design specifies; the lower bound only rules out the empty case.
    expect(
      text.trim().length,
      `${path} description is too short to be a description`,
    ).toBeGreaterThan(20);
    const clashingDescription = descriptions.get(text);
    expect(
      clashingDescription,
      `${path} repeats the description of ${String(clashingDescription)}`,
    ).toBeUndefined();
    descriptions.set(text, path);

    // The canonical is absolute, on this origin, self-referential, and carries no trailing slash.
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical, `${path} has no canonical`).toBeTruthy();
    const url = new URL(String(canonical));
    expect(url.origin, `${path} canonical points off-origin`).toBe(origin);
    expect(url.pathname, `${path} canonical is not self-referential`).toBe(path);
    if (url.pathname !== '/') {
      expect(url.pathname.endsWith('/'), `${path} canonical has a trailing slash`).toBe(false);
    }

    // Open Graph agrees with the page it is on.
    expect(await metaContent(page, 'og:title')).toBe(title);
    expect(await metaContent(page, 'og:url')).toBe(canonical);
    expect(await metaContent(page, 'og:locale')).toBe('en_IN');

    // Nothing public is marked noindex.
    const robots = await metaContent(page, 'robots');
    if (robots !== null) {
      expect(robots.toLowerCase(), `${path} is marked noindex`).not.toContain('noindex');
    }
  }
});

test('a product page has its own title, description and canonical', async ({ page, request }) => {
  const origin = await configuredOrigin(request);
  const seen = new Set<string>();

  for (const slug of [FIXTURES.sofa.slug, FIXTURES.diningTable.slug]) {
    await page.goto(`/product/${slug}`, { waitUntil: 'domcontentloaded' });

    const title = await page.title();
    expect(title.length, `${slug} title is ${String(title.length)} chars`).toBeLessThanOrEqual(
      TITLE_MAX,
    );
    expect(seen.has(title), `${slug} repeats another product's title`).toBe(false);
    seen.add(title);

    const description = String(await metaContent(page, 'description'));
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(description.trim().length).toBeGreaterThan(20);

    const canonical = String(await page.locator('link[rel="canonical"]').getAttribute('href'));
    expect(new URL(canonical).origin).toBe(origin);
    expect(new URL(canonical).pathname).toBe(`/product/${slug}`);
  }
});

test('structured data is present and valid where the design places it', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const home = await jsonLdTypes(page);
  expect(home).toContain('WebSite');
  expect(home).toContain('FurnitureStore');

  // The WebSite block carries the SearchAction with a resolvable target.
  const search = await page.evaluate(() => {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      const block = JSON.parse(node.textContent ?? '{}') as Record<string, unknown>;
      if (block['@type'] === 'WebSite') return block['potentialAction'] ?? null;
    }
    return null;
  });
  expect(JSON.stringify(search)).toContain('SearchAction');

  await page.goto('/contact', { waitUntil: 'domcontentloaded' });
  expect(await jsonLdTypes(page)).toContain('FurnitureStore');

  await page.goto('/collection', { waitUntil: 'domcontentloaded' });
  expect(await jsonLdTypes(page)).toContain('ItemList');
  // The list names the published products and nothing else.
  const itemList = JSON.stringify(
    (await page.locator('script[type="application/ld+json"]').allTextContents())
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((block) => block['@type'] === 'ItemList'),
  );
  expect(itemList).toContain(FIXTURES.sofa.slug);
  expect(itemList).not.toContain(FIXTURES.draftChair.slug);

  await page.goto(`/collection/${CATEGORY_SLUGS[0]}`, { waitUntil: 'domcontentloaded' });
  const category = await jsonLdTypes(page);
  expect(category).toStrictEqual(['BreadcrumbList', 'ItemList']);

  // Every block on every public page parses, and none is empty.
  for (const path of PUBLIC_PAGES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const text of blocks) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed['@context'], `${path} has a block with no @context`).toBe('https://schema.org');
      expect(parsed['@type'], `${path} has a block with no @type`).toBeTruthy();
    }
  }
});

test('no rating markup is emitted while no review is published', async ({ page }) => {
  for (const path of ['/', '/reviews', '/collection']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    for (const text of blocks) {
      expect(text, `${path} claims a rating`).not.toContain('aggregateRating');
      expect(text, `${path} claims a rating`).not.toContain('AggregateRating');
    }
  }
});

test('every product image carries alt text', async ({ page }) => {
  for (const path of PUBLIC_PAGES) {
    await page.goto(path, { waitUntil: 'load' });
    const missing = await page.evaluate(() => {
      const bad: string[] = [];
      for (const image of document.querySelectorAll('img')) {
        // A decorative image is allowed `alt=""`, but the attribute itself must be present so a
        // screen reader is told it is decorative rather than left to guess.
        if (!image.hasAttribute('alt')) bad.push(image.currentSrc || image.src || '(no src)');
      }
      return bad;
    });
    expect(missing, `image(s) with no alt attribute on ${path}`).toStrictEqual([]);
  }
});

test('sitemap.xml is fetchable, complete, and free of anything unpublished', async ({
  request,
}) => {
  const origin = await configuredOrigin(request);
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/xml');
  const xml = await response.text();

  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
  expect(locations.length).toBeGreaterThan(0);

  for (const location of locations) {
    expect(location.startsWith(origin), `sitemap entry is off-origin: ${location}`).toBe(true);
    const { pathname } = new URL(location);
    expect(pathname, 'sitemap lists an admin URL').not.toContain('/admin');
    expect(pathname, 'sitemap lists an API URL').not.toContain('/api');
    expect(pathname, 'sitemap lists a preview URL').not.toContain('/preview');
    if (pathname !== '/') {
      expect(pathname.endsWith('/'), `sitemap entry has a trailing slash: ${pathname}`).toBe(false);
    }
    // Clean, ID-free URLs.
    expect(pathname, `sitemap entry carries a query or id: ${pathname}`).toMatch(
      /^\/[a-z0-9\-/]*$/,
    );
  }

  const paths = new Set(locations.map((location) => new URL(location).pathname));
  for (const path of PUBLIC_PAGES) {
    expect(paths.has(path), `sitemap is missing ${path}`).toBe(true);
  }
  // No duplicate entries.
  expect(paths.size).toBe(locations.length);
  // Exactly the published products, and only those: a draft in the sitemap is an invitation to index
  // something that answers 404.
  const productPaths = [...paths].filter((path) => path.startsWith('/product/')).sort();
  expect(productPaths).toStrictEqual(
    [`/product/${FIXTURES.diningTable.slug}`, `/product/${FIXTURES.sofa.slug}`].sort(),
  );
  expect(productPaths).toHaveLength(PUBLISHED_FIXTURE_COUNT);
  expect(xml, 'the sitemap lists a draft product').not.toContain(FIXTURES.draftChair.slug);
});

test('robots.txt disallows the private surfaces and points at the sitemap', async ({ request }) => {
  const response = await request.get('/robots.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');
  const body = await response.text();

  expect(body).toContain('User-agent: *');
  expect(body).toContain('Disallow: /admin');
  expect(body).toContain('Disallow: /api');
  expect(body).toContain('Disallow: /img/*/*-2000.');
  expect(body).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
  // The sitemap it advertises is the one that exists.
  const advertised = String(/^Sitemap:\s*(\S+)$/m.exec(body)?.[1]);
  expect(new URL(advertised).pathname).toBe('/sitemap.xml');
});

test('a trailing slash redirects in one hop to the canonical path', async ({ request }) => {
  // Two layers answer this, and both are asserted rather than assumed.
  //
  // Prerendered HTML never reaches the Worker — Cloudflare's asset store answers it, and
  // `html_handling = "drop-trailing-slash"` in wrangler.toml is what drops the slash. That layer
  // issues a 307, not a 301; the status is Cloudflare's to choose, and the self-referential
  // canonical link on the destination is what actually consolidates the two URLs for a crawler.
  for (const path of ['/collection/', '/contact/', '/collection/sofas/']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect([301, 307, 308], `${path} did not redirect`).toContain(response.status());
    const location = response.headers()['location'];
    expect(location, `${path} redirected without a Location`).toBeTruthy();
    const target = new URL(String(location), 'http://x');
    expect(target.pathname, `${path} redirected somewhere unexpected`).toBe(
      path.replace(/\/$/, ''),
    );
    // One hop: the destination is a page, not another redirect.
    const followed = await request.get(target.pathname, { maxRedirects: 0 });
    expect(followed.status(), `${path} needed a second hop`).toBe(200);
  }
});

test('a Worker-rendered route answers a trailing slash with a permanent redirect', async ({
  request,
}) => {
  // `/admin/login` is on-demand rendered, so the middleware's own canonicaliser handles it — and
  // that one is a 301, which is the status the design specifies for a URL that has moved for good.
  const response = await request.get('/admin/login/', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(new URL(String(response.headers()['location']), 'http://x').pathname).toBe('/admin/login');
});

test('a query string survives the trailing-slash redirect', async ({ request }) => {
  const response = await request.get('/admin/login/?next=%2Fadmin%2Fsettings', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  const target = new URL(String(response.headers()['location']), 'http://x');
  expect(target.pathname).toBe('/admin/login');
  expect(target.searchParams.get('next')).toBe('/admin/settings');
});

test('an unknown path answers 404 with the designed copy and is not indexable', async ({
  page,
  request,
}) => {
  const response = await request.get('/collection/not-a-category');
  expect(response.status()).toBe(404);

  await page.goto('/product/nothing-is-published-yet', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-404-heading]')).toBeVisible();
  const robots = await metaContent(page, 'robots');
  expect(String(robots).toLowerCase()).toContain('noindex');
});

test('admin pages are marked noindex at the header level', async ({ request }) => {
  for (const path of ['/admin/login', ...ADMIN_PAGES]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.headers()['x-robots-tag'], `${path} is missing its x-robots-tag`).toBe(
      'noindex, nofollow',
    );
  }
});
