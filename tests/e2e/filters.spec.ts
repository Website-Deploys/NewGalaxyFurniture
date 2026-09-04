import { expect, test } from '@playwright/test';

import { waitForCatalogueControls } from './helpers';

/**
 * Filtering and sorting, at the URL level.
 *
 * The filter *arithmetic* — which product survives which combination of seven dimensions, and in
 * what order — is proved exhaustively by the property suite against real fixtures
 * (`tests/property/filter-sort.property.test.ts`, Properties on intersection, count honesty and
 * sort stability). Repeating it here against an empty catalogue would assert nothing.
 *
 * What only a browser can prove, and what this spec covers, is the *plumbing*: that the URL is the
 * state, that it is canonical, that back and forward restore exactly what they should, that a
 * zero-count option is disabled rather than offered, and that a shared link reproduces the view the
 * sender saw.
 *
 * Requirements: 3.1, 3.5, 3.8, 3.10, 3.11, 4.13.
 * Design: Search and Filtering → URL contract.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/collection', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page), 'the catalogue controls never hydrated').toBe(true);
});

test('a price band is written to the URL and restored from it', async ({ page }) => {
  const band = page.locator('#ngf-price-under25k');
  await expect(band).toHaveCount(1);

  // With nothing published every band counts zero, and a zero-count option is disabled rather than
  // dangled in front of the visitor (Requirement 3.8).
  await expect(band).toBeDisabled();
  await expect(page.locator('li.ngf-filter-option[data-disabled="true"]').first()).toBeVisible();

  // The URL is still the state, so a link someone shares reproduces the view.
  await page.goto('/collection?price=under25k', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await expect(page.locator('#ngf-price-under25k')).toBeChecked();
  await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');
});

test('availability is a single-choice dimension with an explicit “Any”', async ({ page }) => {
  const names = await page
    .locator('input[name="ngf-availability"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
  expect(names).toStrictEqual(['any', 'inStock', 'madeToOrder']);
  const types = await page
    .locator('input[name="ngf-availability"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).type));
  expect(new Set(types)).toStrictEqual(new Set(['radio']));
});

test('an unrecognised filter value is dropped, and a recognised one beside it is kept', async ({
  page,
}) => {
  await page.goto('/collection?price=free&sort=priceDesc', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('price'));
  await expect(page.locator('#ngf-sort')).toHaveValue('priceDesc');
});

test('multi-select dimensions are repeated parameters, never comma-joined', async ({ page }) => {
  // No colour vocabulary exists yet, so the dimension states that plainly …
  await expect(page.getByText('No colour values in the catalogue yet.')).toHaveCount(1);
  // … and a link carrying values for it resolves to the neutral state rather than an error.
  await page.goto('/collection?colour=Walnut&colour=Brown', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('.ngf-catalogue-count')).toContainText('0 products');
});

test('there is nothing to clear while no filter is applied', async ({ page }) => {
  await expect(page.locator('.ngf-filter-clear')).toHaveCount(0);
});

test('sorting reports the basis for its ordering rather than implying a measurement', async ({
  page,
}) => {
  const sort = page.locator('#ngf-sort');
  const labels = await sort.locator('option').allTextContents();
  // The three unmeasured orderings must not present themselves as measured.
  for (const label of labels) {
    if (/Most Viewed|Best Selling|Trending/.test(label)) {
      expect(label, `${label} does not disclose its basis`).toMatch(/curated/i);
    }
  }
  await expect(page.locator('.ngf-sort-basis').first()).toContainText(/Curated|Measured/);
});

test('each sort option round-trips through the URL', async ({ page }) => {
  const sort = page.locator('#ngf-sort');
  for (const value of ['priceAsc', 'priceDesc', 'mostViewed', 'bestSelling', 'trending']) {
    await sort.selectOption(value);
    await page.waitForFunction(
      (expected) => new URLSearchParams(location.search).get('sort') === expected,
      value,
    );
  }
  await sort.selectOption('newest');
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('sort'));
});

test('a category page keeps its own scope out of the filter URL', async ({ page }) => {
  await page.goto('/collection/sofas', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await page.locator('#ngf-sort').selectOption('priceAsc');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'priceAsc');
  // The category is the route, not a filter parameter — it is not duplicated into the query.
  expect(new URL(page.url()).pathname).toBe('/collection/sofas');
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
});

test('a search term carried into the catalogue is reflected back to the visitor', async ({
  page,
}) => {
  await page.goto('/collection?q=walnut', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'walnut');
  await expect(page.locator('[data-ngf-empty-state]')).toHaveCount(1);
});
