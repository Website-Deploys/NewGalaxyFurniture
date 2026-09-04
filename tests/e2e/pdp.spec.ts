import { expect, test } from '@playwright/test';

import { FIXTURES } from './helpers';

/**
 * The product detail page.
 *
 * **Where the products come from.** `data/products/` is empty and stays empty — no real photography
 * or prices exist yet, and the spec forbids writing a demo product into it. So `npm run e2e:prepare`
 * writes `tests/fixtures/products.ts` into a git-ignored directory and the build reads the products
 * collection from there for this run only (`NGF_PRODUCTS_DIR`, see `src/content.config.ts`). Nothing
 * invents a product, nothing reaches the repository, and every assertion below runs against a real
 * built page rather than a mock.
 *
 * The fixtures were chosen to cover both sides of the pricing branch: the sofa has a price, a
 * strike-through original and two photographs; the dining table is price-on-enquiry and made to
 * order. The accent chair is a `DRAFT` and is the control — it must appear nowhere public.
 *
 * Requirements: 1.16, 6.1, 6.2, 6.5, 6.7, 6.9, 23.4, 26.11.
 * Design: Pages, Navigation, and States → Product detail.
 */

test('a published product page carries its identity, price, stock and both numbers', async ({
  page,
}) => {
  await page.goto(`/product/${FIXTURES.sofa.slug}`, { waitUntil: 'load' });

  const article = page.locator('[data-product]');
  await expect(article).toHaveAttribute('data-product', FIXTURES.sofa.slug);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText(FIXTURES.sofa.name);
  await expect(page.getByText(`SKU ${FIXTURES.sofa.sku}`)).toHaveCount(1);

  // In stock, and the badge says so rather than leaving the visitor to infer it.
  const badge = page.locator('.ngf-stock-badge');
  await expect(badge).toHaveAttribute('data-stock', 'IN_STOCK');
  await expect(badge).toHaveAttribute('data-out-of-stock', 'false');

  // The price, in rupees, with the original struck through — a discount claim needs both numbers.
  const body = await page.locator('main#main').innerText();
  expect(body).toContain('₹42,000');
  expect(body).toContain('₹52,500');

  // Breadcrumbs land on the catalogue and the category, and mark the current page.
  const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
  await expect(crumbs.locator('a[href="/collection"]')).toHaveCount(1);
  await expect(crumbs.locator(`a[href="/collection/${FIXTURES.sofa.category}"]`)).toHaveCount(1);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText(FIXTURES.sofa.name);
});

test('the WhatsApp enquiry names the piece it was opened from', async ({ page }) => {
  await page.goto(`/product/${FIXTURES.sofa.slug}`, { waitUntil: 'load' });

  // Scoped to the product article. The shell's header carries a site-wide WhatsApp CTA too, and its
  // message is deliberately generic — asserting against `.first()` on the page would test that one.
  const href = String(
    await page.locator('[data-product] a[data-ngf-whatsapp]').first().getAttribute('href'),
  );
  expect(href).toMatch(/^https:\/\/wa\.me\/\d{8,15}\?text=/);

  // The message decodes back to prose that identifies this product — the whole point of a
  // product-specific enquiry is that the operator does not have to ask which one.
  const message = decodeURIComponent(new URL(href).searchParams.get('text') ?? '');
  expect(message).toContain(FIXTURES.sofa.name);
  expect(message).toContain(FIXTURES.sofa.sku);
  // Single-encoded: a double-encoded message arrives as literal %20 in the chat.
  expect(message).not.toContain('%20');

  await expect(page.locator('[data-product] a[data-ngf-call]').first()).toHaveAttribute(
    'href',
    /^tel:\+\d{8,15}$/,
  );
});

test('a price-on-enquiry product says so and omits the Offer rather than claiming a price', async ({
  page,
}) => {
  await page.goto(`/product/${FIXTURES.diningTable.slug}`, { waitUntil: 'load' });

  await expect(page.locator('main#main')).toContainText('Price on enquiry');

  // Structured data must not carry an `Offer` with a fabricated price. Omission is the honest answer.
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const product = blocks
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .find((block) => block['@type'] === 'Product');
  expect(product, 'no Product block on a product page').toBeTruthy();
  expect(JSON.stringify(product)).not.toContain('"offers"');
  // And no rating, because no review is linked to it.
  expect(JSON.stringify(product)).not.toContain('aggregateRating');
});

test('the Product structured data describes the product it is on', async ({ page }) => {
  await page.goto(`/product/${FIXTURES.sofa.slug}`, { waitUntil: 'load' });

  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const parsed = blocks.map((text) => JSON.parse(text) as Record<string, unknown>);
  const types = parsed.map((block) => block['@type']);
  expect(types).toContain('Product');
  expect(types).toContain('BreadcrumbList');

  const product = parsed.find((block) => block['@type'] === 'Product') as Record<string, unknown>;
  expect(product['name']).toBe(FIXTURES.sofa.name);
  expect(product['sku']).toBe(FIXTURES.sofa.sku);
  const offers = product['offers'] as Record<string, unknown> | undefined;
  expect(offers?.['priceCurrency']).toBe('INR');
  expect(String(offers?.['price'])).toBe('42000');
});

test('the gallery is keyboard operable and reports its position', async ({ page }) => {
  await page.goto(`/product/${FIXTURES.sofa.slug}`, { waitUntil: 'load' });

  const gallery = page.locator('.ngf-gallery');
  await expect(gallery).toHaveAttribute('data-total', String(FIXTURES.sofa.images));
  await expect(gallery).toHaveAttribute('data-index', '0');

  await gallery.locator('[data-ngf-gallery-primary]').focus();

  // Arrow keys step, and only arrow keys: `gallery-state.ts` documents that Home and End are left to
  // the browser so they still scroll the page, which is why they are not asserted here.
  await page.keyboard.press('ArrowRight');
  await expect(gallery).toHaveAttribute('data-index', '1');

  // Requirement 4.15: ArrowRight at the last image takes no action — it does not wrap to the first,
  // because a visitor who has reached the end is told so by nothing happening.
  await page.keyboard.press('ArrowRight');
  await expect(gallery).toHaveAttribute('data-index', String(FIXTURES.sofa.images - 1));

  await page.keyboard.press('ArrowLeft');
  await expect(gallery).toHaveAttribute('data-index', '0');
  // And ArrowLeft at the first image likewise does nothing.
  await page.keyboard.press('ArrowLeft');
  await expect(gallery).toHaveAttribute('data-index', '0');

  await expect(gallery.locator('[role="status"]')).not.toHaveText('');

  // One layer per photograph — every image stays in the DOM so switching cannot re-fetch — and each
  // carries alt text, including the ones not currently shown. Counted on the layers rather than on
  // every `img`, because the thumbnail rail renders a second copy of each.
  const layerAlts = await gallery
    .locator('.ngf-gallery-layer img')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).alt));
  expect(layerAlts.length).toBe(FIXTURES.sofa.images);
  for (const alt of layerAlts) expect(alt.trim()).not.toBe('');

  // And nothing anywhere in the gallery, thumbnails included, is missing the attribute.
  const missing = await gallery
    .locator('img')
    .evaluateAll((nodes) => nodes.filter((node) => !node.hasAttribute('alt')).length);
  expect(missing).toBe(0);
});

test('a swipe steps the gallery where touch is available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/product/${FIXTURES.sofa.slug}`, { waitUntil: 'load' });

  const stage = page.locator('.ngf-gallery-stage');
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };

  // Past the 40 px threshold, right to left: the next photograph.
  await page.locator('.ngf-gallery').evaluate(
    (node, coords) => {
      const touch = (clientX: number): TouchEventInit => ({
        touches: [new Touch({ identifier: 1, target: node, clientX, clientY: coords.cy })],
        changedTouches: [new Touch({ identifier: 1, target: node, clientX, clientY: coords.cy })],
        bubbles: true,
      });
      const stageNode = node.querySelector('.ngf-gallery-stage') as Element;
      stageNode.dispatchEvent(new TouchEvent('touchstart', touch(coords.from)));
      stageNode.dispatchEvent(new TouchEvent('touchend', touch(coords.to)));
    },
    { cy: y + height / 2, from: x + width * 0.8, to: x + width * 0.2 },
  );

  await expect(page.locator('.ngf-gallery')).toHaveAttribute('data-index', '1');
});

test('a draft product appears on no public surface', async ({ page, request }) => {
  // The control for Requirement 1.16. The fixture catalogue contains a DRAFT precisely so this can
  // be asserted rather than assumed.
  const response = await request.get(`/product/${FIXTURES.draftChair.slug}`, { maxRedirects: 0 });
  expect(response.status(), 'a draft product has a public page').toBe(404);

  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap, 'a draft product is in the sitemap').not.toContain(FIXTURES.draftChair.slug);

  await page.goto(`/collection/${FIXTURES.draftChair.category}`, { waitUntil: 'load' });
  await expect(page.locator(`[data-slug="${FIXTURES.draftChair.slug}"]`)).toHaveCount(0);
  // Its category counts it in nothing.
  await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');
});

test('an unpublished slug is a genuine 404 with the copy written for it, and is not indexable', async ({
  page,
  request,
}) => {
  expect((await request.get('/product/never-published', { maxRedirects: 0 })).status()).toBe(404);

  await page.goto('/product/never-published', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-404-heading]')).toContainText('That piece is not available');
  await expect(page.locator('[data-ngf-404-message]')).not.toHaveText('');
  const robots = await page.locator('meta[name="robots"]').getAttribute('content');
  expect(String(robots).toLowerCase()).toContain('noindex');
  // It does not dead-end: the catalogue and both numbers are reachable from here.
  await expect(page.locator('a[href="/collection"]').first()).toHaveCount(1);
  await expect(page.locator('a[data-ngf-whatsapp]').first()).toHaveAttribute(
    'href',
    /^https:\/\/wa\.me\//,
  );
});
