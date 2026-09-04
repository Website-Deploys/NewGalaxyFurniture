import { expect, test } from '@playwright/test';

/**
 * The product detail page.
 *
 * **Read this before adding an assertion here.** `data/products/` is empty on purpose and stays
 * empty until the operator supplies real photography, real dimensions and real prices — the spec
 * forbids writing a demo product into it, and demo products live only in `tests/fixtures/`. With no
 * product file there is no `/product/{slug}` route to visit, because `getStaticPaths` folds over the
 * published catalogue. So the PDP's *contents* cannot be asserted end to end today, and pretending
 * otherwise by seeding a fake sofa would make the suite green by making the site dishonest.
 *
 * What is asserted instead is the behaviour that is real today, and it is not a placeholder:
 *
 * - a product URL answers a genuine 404 with the copy written for exactly this case, rather than an
 *   empty shell that looks like a broken product page;
 * - that 404 is not indexable, so an unpublished slug cannot enter a search index;
 * - the conversion controls the PDP would carry are proved on every other page by
 *   `conversion.spec.ts`, and the PDP's own composition — gallery state, WhatsApp message body,
 *   stock labelling, related products, `Product` JSON-LD — is covered against fixtures by the unit
 *   and property suites (`tests/unit/product-detail.test.ts`,
 *   `tests/property/whatsapp.property.test.ts`, `tests/unit/seo.jsonld.test.ts`).
 *
 * When the first product is published, the `test.skip` below stops skipping and the assertions run
 * against it unchanged. That is the point of writing them now.
 *
 * Requirements: 1.16, 6.1, 6.7, 23.4, 26.11.
 * Design: Pages, Navigation, and States → Product detail; Open Items.
 */

/** The first published product's slug, or `null` while the catalogue is empty. */
async function firstPublishedSlug(request: {
  get: (url: string) => Promise<{ text: () => Promise<string> }>;
}): Promise<string | null> {
  const xml = await (await request.get('/sitemap.xml')).text();
  const match = /<loc>[^<]*\/product\/([^<]+)<\/loc>/.exec(xml);
  return match?.[1] ?? null;
}

test('a product URL answers a genuine 404 while nothing is published', async ({ request }) => {
  const response = await request.get('/product/any-slug-at-all', { maxRedirects: 0 });
  expect(response.status()).toBe(404);
});

test('the 404 explains itself in the words written for a missing piece', async ({ page }) => {
  await page.goto('/product/any-slug-at-all', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-404-heading]')).toContainText('That piece is not available');
  await expect(page.locator('[data-ngf-404-message]')).not.toHaveText('');
  // And it does not dead-end: the catalogue and the two numbers are all reachable from here.
  await expect(page.locator('a[href="/collection"]').first()).toHaveCount(1);
  await expect(page.locator('a[data-ngf-whatsapp]').first()).toHaveAttribute(
    'href',
    /^https:\/\/wa\.me\//,
  );
});

test('no unpublished product slug is indexable', async ({ page }) => {
  await page.goto('/product/any-slug-at-all', { waitUntil: 'load' });
  const robots = await page.locator('meta[name="robots"]').getAttribute('content');
  expect(String(robots).toLowerCase()).toContain('noindex');
});

test('a published product detail page carries its identity, price, stock and both numbers', async ({
  page,
  request,
}) => {
  const slug = await firstPublishedSlug(request);
  test.skip(
    slug === null,
    'no product is published yet — the catalogue ships empty by design (see the header of this file)',
  );

  await page.goto(`/product/${String(slug)}`, { waitUntil: 'load' });

  const article = page.locator('[data-product]');
  await expect(article).toHaveAttribute('data-product', String(slug));
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByText(/^SKU /)).toHaveCount(1);
  await expect(page.locator('.ngf-stock-badge')).toHaveCount(1);

  const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
  await expect(crumbs.locator('a[href="/collection"]')).toHaveCount(1);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveCount(1);

  // The WhatsApp message names this piece, and decodes back to something a human wrote.
  const whatsapp = String(await page.locator('a[data-ngf-whatsapp]').first().getAttribute('href'));
  expect(whatsapp).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
  const message = decodeURIComponent(new URL(whatsapp).searchParams.get('text') ?? '');
  const name = String(await page.locator('h1').textContent()).trim();
  expect(message).toContain(name);

  await expect(page.locator('a[data-ngf-call]').first()).toHaveAttribute('href', /^tel:\+\d+$/);

  // Product structured data, with no invented rating.
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const types = blocks.map((text) => (JSON.parse(text) as { '@type'?: string })['@type']);
  expect(types).toContain('Product');
  expect(types).toContain('BreadcrumbList');
});

test('a published product’s gallery is keyboard operable and swipeable', async ({
  page,
  request,
}) => {
  const slug = await firstPublishedSlug(request);
  test.skip(slug === null, 'no product is published yet — see the header of this file');

  await page.goto(`/product/${String(slug)}`, { waitUntil: 'load' });
  const gallery = page.locator('.ngf-gallery');
  test.skip((await gallery.count()) === 0, 'this product has no photographs yet');

  const total = Number(await gallery.getAttribute('data-total'));
  test.skip(total < 2, 'a single-image gallery has nothing to step through');

  await expect(gallery).toHaveAttribute('data-index', '0');
  await gallery.locator('[data-ngf-gallery-primary]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(gallery).toHaveAttribute('data-index', '1');
  await page.keyboard.press('Home');
  await expect(gallery).toHaveAttribute('data-index', '0');
  await expect(gallery.locator('[role="status"]')).not.toHaveText('');
});
