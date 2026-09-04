import { expect, test } from '@playwright/test';

import { CATEGORY_SLUGS, waitForCatalogueControls } from './helpers';

/**
 * The catalogue and the nine category routes.
 *
 * `data/products/` is empty by design — no real photography or real prices exist yet — so what is
 * under test here is the state the site actually ships in: every listing renders its designed empty
 * state, states the count honestly, and still offers a route to the business. The assertions that
 * need a published product are in `pdp.spec.ts`, gated and explained there.
 *
 * A grid that appeared today would be the defect, so its absence is asserted rather than assumed.
 *
 * Requirements: 1.16, 2.11, 3.1, 4.1, 26.11.
 * Design: Pages, Navigation, and States → Catalogue; Open Items.
 */

test('the collection page states the count honestly and offers the designed empty state', async ({
  page,
}) => {
  await page.goto('/collection', { waitUntil: 'load' });

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');

  const empty = page.locator('[data-ngf-empty-state]');
  await expect(empty).toHaveCount(1);
  await expect(empty.locator('.ngf-emptystate-heading')).toHaveText(
    'The catalogue is being photographed',
  );
  await expect(empty.locator('.ngf-emptystate-message')).not.toHaveText('');

  // No grid, and no "no products match your filters" state either — there are no filters applied.
  await expect(page.locator('#ngf-collection-grid')).toHaveCount(0);
  await expect(page.locator('[data-product-card]')).toHaveCount(0);

  // Every category is still reachable from the empty state.
  for (const slug of CATEGORY_SLUGS) {
    await expect(empty.locator(`a[href="/collection/${slug}"]`)).toHaveCount(1);
  }
});

for (const slug of CATEGORY_SLUGS) {
  test(`/collection/${slug} renders, names itself and breadcrumbs back to the catalogue`, async ({
    page,
  }) => {
    const response = await page.goto(`/collection/${slug}`, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).not.toHaveText('');
    await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');

    const crumbs = page.locator('nav[aria-label="Breadcrumb"]');
    await expect(crumbs).toHaveCount(1);
    await expect(crumbs.locator('a[href="/collection"]')).toHaveCount(1);
    await expect(crumbs.locator('[aria-current="page"]')).toHaveCount(1);

    const empty = page.locator('[data-ngf-empty-state]');
    await expect(empty).toHaveCount(1);
    await expect(empty.locator('.ngf-emptystate-heading')).toContainText('is being photographed');
    await expect(page.locator('#ngf-category-grid')).toHaveCount(0);
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

  // At this project's 1280 px the filters are a permanently visible sidebar; the sheet opener is
  // the narrow-viewport affordance and `responsive.spec.ts` drives it at every width.
  const toggle = page.locator('.ngf-filter-toggle');
  const shell = page.locator(`#${String(await toggle.getAttribute('aria-controls'))}`);
  await expect(shell).toBeVisible();

  // Price and availability are static vocabularies and always render.
  for (const legend of ['Price', 'Availability']) {
    await expect(shell.locator('fieldset legend', { hasText: legend })).toHaveCount(1);
  }
  await expect(shell.locator('input[name="ngf-price"]')).not.toHaveCount(0);
  await expect(shell.locator('input[name="ngf-availability"]')).not.toHaveCount(0);

  // The five catalogue-derived dimensions say so plainly rather than rendering an empty list.
  for (const dimension of ['category', 'material', 'colour', 'size', 'style']) {
    await expect(
      shell.getByText(`No ${dimension} values in the catalogue yet.`),
      `${dimension} dimension`,
    ).toHaveCount(1);
  }

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

test('the reviews and gallery pages render their empty states without inventing content', async ({
  page,
}) => {
  await page.goto('/reviews', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-empty-state] .ngf-emptystate-heading')).toHaveText(
    'No reviews published yet',
  );
  await expect(page.locator('.ngf-reviewlist')).toHaveCount(0);

  await page.goto('/gallery', { waitUntil: 'load' });
  await expect(page.locator('[data-ngf-empty-state] .ngf-emptystate-heading')).toHaveText(
    'Photography is in progress',
  );
  await expect(page.locator('.ngf-gallerypage')).toHaveCount(0);
});
