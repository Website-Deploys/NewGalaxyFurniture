import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { FIXTURES, PUBLISHED_FIXTURE_COUNT, waitForCatalogueControls } from './helpers';

/**
 * Filtering and sorting, against a real catalogue.
 *
 * The filter *arithmetic* — which product survives which combination of seven dimensions, and in what
 * order — is proved exhaustively by the property suite (`tests/property/filter-sort.property.test.ts`).
 * What only a browser can prove, and what this spec covers, is the plumbing: that a control narrows
 * the listing on screen, that the URL is the state, that it is canonical and shareable, that back and
 * forward restore exactly what they should, and that a zero-count option is disabled rather than
 * offered.
 *
 * The two published fixtures are deliberately disjoint on every dimension — different category,
 * material, colour and price band, one in stock and one made to order — so a single filter always
 * narrows two products to one, and the assertion is unambiguous.
 *
 * Requirements: 3.1, 3.5, 3.8, 3.10, 3.11, 4.13.
 * Design: Search and Filtering → URL contract.
 */

/** Cards currently shown. `applyResults` hides rather than removes, so visibility is the question. */
async function shownSlugs(page: Page): Promise<string[]> {
  return page
    .locator('[data-product-card]')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => (node as HTMLElement).checkVisibility())
        .map((node) => node.getAttribute('data-slug') ?? ''),
    );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/collection', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page), 'the catalogue controls never hydrated').toBe(true);
});

test('a category filter narrows the listing and is written to the URL', async ({ page }) => {
  expect(await shownSlugs(page)).toHaveLength(PUBLISHED_FIXTURE_COUNT);

  await page.locator(`#ngf-category-${FIXTURES.sofa.category}`).check();
  await page.waitForFunction(
    (expected) => new URLSearchParams(location.search).getAll('category').includes(expected),
    FIXTURES.sofa.category,
  );

  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);
  await expect(page.locator('[role="status"]').last()).toContainText('1 product');
});

test('a shared filter URL reproduces the view the sender saw', async ({ page }) => {
  await page.goto(`/collection?category=${FIXTURES.sofa.category}`, { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);

  await expect(page.locator(`#ngf-category-${FIXTURES.sofa.category}`)).toBeChecked();
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);
});

test('a price band narrows on price, and an empty band is disabled rather than offered', async ({
  page,
}) => {
  // The sofa is ₹42,000 — inside 25k–50k, outside under-25k.
  await page.locator('#ngf-price-25k-50k').check();
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);

  // Nothing is under ₹25,000, so that band would return nothing and says so by being disabled
  // (Requirement 3.8) rather than letting someone filter their way to an empty page.
  await expect(page.locator('#ngf-price-under25k')).toBeDisabled();
  await expect(page.locator('li.ngf-filter-option[data-disabled="true"]').first()).toBeVisible();
});

test('availability is a single-choice dimension and separates the two products', async ({
  page,
}) => {
  const values = await page
    .locator('input[name="ngf-availability"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
  expect(values).toStrictEqual(['any', 'inStock', 'madeToOrder']);
  const types = await page
    .locator('input[name="ngf-availability"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).type));
  expect(new Set(types)).toStrictEqual(new Set(['radio']));

  await page.locator('#ngf-availability-inStock').check();
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);

  await page.locator('#ngf-availability-madeToOrder').check();
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.diningTable.slug]);
});

test('a second filter narrows the first, and an option that would empty the page is disabled', async ({
  page,
}) => {
  // Intersection, not accumulation — and the design refuses to let anyone filter their way into an
  // empty page in the first place. Selecting the sofa's category leaves one product, which is not
  // made to order, so the made-to-order option now counts zero and is disabled (Requirement 3.8).
  // The disabling *is* the intersection being reported, before the click rather than after it.
  await page.locator(`#ngf-category-${FIXTURES.sofa.category}`).check();
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);

  await expect(page.locator('#ngf-availability-madeToOrder')).toBeDisabled();
  await expect(page.locator('#ngf-availability-inStock')).toBeEnabled();
});

test('a link to an empty intersection reports it rather than showing the union', async ({
  page,
}) => {
  // The URL is the state, so a combination nobody could reach through the controls can still arrive
  // by link. It must produce the no-match state, not the union of the two filters.
  await page.goto(`/collection?category=${FIXTURES.sofa.category}&availability=madeToOrder`, {
    waitUntil: 'load',
  });
  expect(await waitForCatalogueControls(page)).toBe(true);

  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([]);
  const noMatch = page.locator('#ngf-collection-nomatch');
  await expect(noMatch).toBeVisible();
  await expect(noMatch).toContainText('No products match these filters');
  // And it offers a way out rather than a dead end.
  await expect(noMatch.locator('a[href="/collection"]').first()).toHaveCount(1);
});

test('clearing restores everything and empties the query string', async ({ page }) => {
  await page.locator(`#ngf-category-${FIXTURES.sofa.category}`).check();
  await page.waitForFunction(() => location.search !== '');

  await page.locator('.ngf-filter-clear').click();
  await page.waitForFunction(() => location.search === '');
  await expect.poll(async () => (await shownSlugs(page)).length).toBe(PUBLISHED_FIXTURE_COUNT);
});

test('there is nothing to clear until a filter is applied', async ({ page }) => {
  await expect(page.locator('.ngf-filter-clear')).toHaveCount(0);
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
  await page.locator(`#ngf-category-${FIXTURES.sofa.category}`).check();
  await page.locator(`#ngf-category-${FIXTURES.diningTable.category}`).check();

  await page.waitForFunction(
    (n) => new URLSearchParams(location.search).getAll('category').length === n,
    2,
  );
  const search = new URL(page.url()).search;
  expect(search).toContain(`category=${FIXTURES.sofa.category}`);
  expect(search).toContain(`category=${FIXTURES.diningTable.category}`);
  expect(search, 'values were comma-joined').not.toContain('%2C');
  // Both categories selected is both products shown — a union within one dimension.
  await expect.poll(async () => (await shownSlugs(page)).length).toBe(PUBLISHED_FIXTURE_COUNT);
});

test('sorting by price reorders the listing and reports its basis honestly', async ({ page }) => {
  const sort = page.locator('#ngf-sort');

  // A price-on-enquiry product has no price to sort by, and `comparePrice` puts it last in *both*
  // directions rather than pretending it is either the cheapest or the dearest. That is the rule worth
  // pinning at this layer — reversal is not it, and asserting reversal would have demanded the wrong
  // behaviour. The ordering of two priced products against each other is proved exhaustively by
  // `tests/property/filter-sort.property.test.ts`.
  await sort.selectOption('priceAsc');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'priceAsc');
  const ascending = await visualOrder(page);

  await sort.selectOption('priceDesc');
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get('sort') === 'priceDesc',
  );
  const descending = await visualOrder(page);

  expect(ascending).toHaveLength(PUBLISHED_FIXTURE_COUNT);
  expect(descending).toHaveLength(PUBLISHED_FIXTURE_COUNT);
  expect(ascending.at(-1), 'price on enquiry is not last under priceAsc').toBe(
    FIXTURES.diningTable.slug,
  );
  expect(descending.at(-1), 'price on enquiry is not last under priceDesc').toBe(
    FIXTURES.diningTable.slug,
  );

  // The three unmeasured orderings must not present themselves as measured.
  for (const label of await sort.locator('option').allTextContents()) {
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
  await page.goto(`/collection/${FIXTURES.sofa.category}`, { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await page.locator('#ngf-sort').selectOption('priceAsc');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('sort') === 'priceAsc');
  // The category is the route, not a filter parameter — it is not duplicated into the query.
  expect(new URL(page.url()).pathname).toBe(`/collection/${FIXTURES.sofa.category}`);
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
});

test('a search term carried into the catalogue filters the listing', async ({ page }) => {
  await page.goto('/collection?q=sheesham', { waitUntil: 'load' });
  expect(await waitForCatalogueControls(page)).toBe(true);
  await page.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'sheesham');
  // The sofa's material is Sheesham Wood; the query reaches the listing rather than only the box.
  await expect.poll(async () => await shownSlugs(page)).toStrictEqual([FIXTURES.sofa.slug]);
});

/** The slugs in the order they are laid out, which `applyResults` controls with `order`. */
async function visualOrder(page: Page): Promise<string[]> {
  return page.locator('[data-product-card]').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const item = (node as HTMLElement).closest('li') ?? (node as HTMLElement);
        return {
          slug: node.getAttribute('data-slug') ?? '',
          order: Number(getComputedStyle(item).order || '0'),
          visible: (node as HTMLElement).checkVisibility(),
        };
      })
      .filter((entry) => entry.visible)
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.slug),
  );
}
