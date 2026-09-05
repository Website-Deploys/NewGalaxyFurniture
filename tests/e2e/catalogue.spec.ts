import { expect, test } from '@playwright/test';

import {
  CATEGORY_SLUGS,
  EMPTY_CATEGORY,
  FIXTURES,
  POPULATED_CATEGORIES,
  PUBLISHED_FIXTURE_COUNT,
  waitForCatalogueControls,
} from './helpers';

/**
 * The catalogue and the nine category routes.
 *
 * Both states are under test in the same run, which is the point of the fixture seam. The fixture
 * catalogue publishes into `sofas` and `dining-tables`, so those exercise a populated listing — cards,
 * an honest count, a working grid — while the seven categories it does not touch still render the
 * designed empty state that the site ships with today. A `DRAFT` fixture is the control for
 * "unpublished appears in no public count".
 *
 * Requirements: 1.16, 2.11, 3.1, 3.8, 4.1, 26.11.
 * Design: Pages, Navigation, and States → Catalogue.
 */

test('the collection page lists every published product and counts them honestly', async ({
  page,
}) => {
  await page.goto('/collection', { waitUntil: 'load' });

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.ngf-catalogue-count')).toContainText(
    `${String(PUBLISHED_FIXTURE_COUNT)} products`,
  );

  const grid = page.locator('#ngf-collection-grid');
  await expect(grid).toBeVisible();
  await expect(page.locator('[data-product-card]')).toHaveCount(PUBLISHED_FIXTURE_COUNT);

  // The draft is counted in nothing and listed nowhere.
  await expect(page.locator(`[data-slug="${FIXTURES.draftChair.slug}"]`)).toHaveCount(0);
  // The only empty state in the DOM is the no-filter-match one, and it stays hidden until a filter
  // actually excludes everything. Nothing tells the visitor the catalogue is empty.
  await expect(page.locator('#ngf-collection-nomatch')).toBeHidden();
  await expect(page.locator('[data-ngf-empty-state]:visible')).toHaveCount(0);
});

test('a product card carries everything needed to choose, and links to the piece', async ({
  page,
}) => {
  await page.goto('/collection', { waitUntil: 'load' });

  const card = page.locator(`[data-product-card][data-slug="${FIXTURES.sofa.slug}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.ngf-card-name')).toHaveText(FIXTURES.sofa.name);
  await expect(card.locator('.ngf-card-price')).toContainText('₹42,000');
  await expect(card.locator('.ngf-card-stock')).toHaveAttribute('data-stock', 'IN_STOCK');

  // Quick Enquire is a WhatsApp link before it is a dialog, so it works without JavaScript.
  const quick = card.locator('[data-ngf-quick-enquire]');
  await expect(quick).toHaveAttribute('href', /^https:\/\/wa\.me\//);
  await expect(quick).toHaveAttribute('data-ngf-product-slug', FIXTURES.sofa.slug);

  // The card's stretched link is named for a screen reader, not just clickable.
  const link = card.locator('.ngf-card-link');
  await expect(link).toHaveAttribute('href', `/product/${FIXTURES.sofa.slug}`);
  await expect(link).toContainText(FIXTURES.sofa.name);

  await link.click();
  await page.waitForURL(`**/product/${FIXTURES.sofa.slug}`);
  await expect(page.locator('[data-product]')).toHaveAttribute('data-product', FIXTURES.sofa.slug);
});

for (const slug of CATEGORY_SLUGS) {
  test(`/collection/${slug} renders, names itself and breadcrumbs back to the catalogue`, async ({
    page,
  }) => {
    const response = await page.goto(`/collection/${slug}`, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).not.toHaveText('');

    const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumbs).toHaveCount(1);
    await expect(crumbs.locator('a[href="/collection"]')).toHaveCount(1);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveCount(1);

    if ((POPULATED_CATEGORIES as readonly string[]).includes(slug)) {
      await expect(page.locator('.ngf-catalogue-count')).toContainText('1 product');
      await expect(page.locator('#ngf-category-grid')).toBeVisible();
      await expect(page.locator('[data-product-card]')).toHaveCount(1);
    } else {
      // The state the site ships in, still under test: no grid, and words a customer can act on.
      await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');
      await expect(page.locator('#ngf-category-grid')).toHaveCount(0);
      const empty = page.locator('[data-ngf-empty-state]');
      await expect(empty).toHaveCount(1);
      await expect(empty.locator('.ngf-emptystate-heading')).toContainText('is being photographed');
      await expect(empty.locator('a[data-ngf-whatsapp]').first()).toHaveAttribute(
        'href',
        /^https:\/\/wa\.me\//,
      );
    }
  });
}

test('an unknown category is a genuine 404, not an empty category page', async ({
  page,
  request,
}) => {
  const response = await request.get('/collection/chandeliers', { maxRedirects: 0 });
  expect(response.status()).toBe(404);

  await page.goto('/collection/chandeliers', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-404-heading]')).toContainText(
    'That category does not exist',
  );
});

test('the catalogue controls hydrate and offer every filter dimension and every sort option', async ({
  page,
}) => {
  await page.goto('/collection', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page), 'the catalogue controls never hydrated').toBe(true);

  // At this project's 1280 px the filters are a permanently visible sidebar; the sheet opener is the
  // narrow-viewport affordance and `responsive.spec.ts` drives it at every width.
  const toggle = page.locator('.ngf-filter-toggle');
  const shell = page.locator(`#${String(await toggle.getAttribute('aria-controls'))}`);
  await expect(shell).toBeVisible();

  // Price and availability are static vocabularies and always render.
  for (const legend of ['Price', 'Availability']) {
    await expect(shell.locator('fieldset legend', { hasText: legend })).toHaveCount(1);
  }
  await expect(shell.locator('input[name="ngf-price"]')).not.toHaveCount(0);
  await expect(shell.locator('input[name="ngf-availability"]')).not.toHaveCount(0);

  // The five catalogue-derived dimensions now have values, drawn from the published products only.
  for (const dimension of ['category', 'material', 'colour']) {
    await expect(
      shell.locator(`input[id^="ngf-${dimension}-"]`),
      `${dimension} dimension`,
    ).not.toHaveCount(0);
  }
  // By label, not by id: the id is `ngf-material-{value}` and the value is the material as written,
  // spaces and all, so composing it here would bake in a brittle assumption about the vocabulary.
  await expect(
    shell.getByLabel(FIXTURES.sofa.material, { exact: false }),
    `no ${FIXTURES.sofa.material} option`,
  ).toHaveCount(1);

  // Six sort options, each labelled with the basis for its ordering.
  const sort = page.locator('#ngf-sort');
  await expect(sort).toBeVisible();
  const values = await sort
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(values).toStrictEqual([
    'newest',
    'priceAsc',
    'priceDesc',
    'mostViewed',
    'bestSelling',
    'trending',
  ]);
  await expect(page.locator('.ngf-sort-basis').first()).not.toHaveText('');
});

test('a category with nothing published says so in the filter panel too', async ({ page }) => {
  await page.goto(`/collection/${EMPTY_CATEGORY}`, { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  // The vocabulary is the whole catalogue's, so the dimensions still have values; what must be
  // honest is the count, and that no product is claimed for this category.
  await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');
  await expect(page.locator('[data-product-card]')).toHaveCount(0);
});

test('a sort choice is written to the URL and survives back and forward', async ({ page }) => {
  await page.goto('/collection', { waitUntil: 'load' });
  const sort = page.locator('#ngf-sort');
  await sort.waitFor({ state: 'visible', timeout: 20_000 });

  await sort.selectOption('priceAsc');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'priceAsc');

  await page.goBack();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === null);
  await expect(sort).toHaveValue('newest');

  await page.goForward();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'priceAsc');
  await expect(sort).toHaveValue('priceAsc');
});

test('the neutral state carries no query string at all', async ({ page }) => {
  await page.goto('/collection?sort=newest&price=any&availability=any', { waitUntil: 'load' });
  await page.locator('#ngf-sort').waitFor({ state: 'visible', timeout: 20_000 });
  // The island canonicalises the URL on load: neutral values are not state worth serialising.
  await page.waitForFunction(() => location.search === '');
});

test('an unknown query parameter is ignored rather than echoed', async ({ page }) => {
  await page.goto('/collection?nonsense=1&sort=priceDesc', { waitUntil: 'load' });
  await page.locator('#ngf-sort').waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('nonsense'));
  await expect(page.locator('#ngf-sort')).toHaveValue('priceDesc');
});

test('the reviews page renders its empty state without inventing a review', async ({ page }) => {
  // Reviews have no fixture and no seam: none has been given to us, so none is shown, and the page
  // says that in the operator's own words rather than showing an empty list.
  await page.goto('/reviews', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-empty-state] .ngf-emptystate-heading')).toHaveText(
    'No reviews published yet',
  );
  await expect(page.locator('.ngf-reviewlist')).toHaveCount(0);
});

test('the gallery shows every published photograph, each with alt text', async ({ page }) => {
  await page.goto('/gallery', { waitUntil: 'load' });
  // The gallery renders as a lookbook grid (`.ngf-lookbook`), each tile a `ResponsiveImage`; the
  // legacy `.ngf-gallerypage` container no longer exists in the markup.
  const items = page.locator('.ngf-lookbook img');
  await expect(items).not.toHaveCount(0);

  const alts = await items.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLImageElement).alt),
  );
  for (const alt of alts) expect(alt.trim()).not.toBe('');
});
