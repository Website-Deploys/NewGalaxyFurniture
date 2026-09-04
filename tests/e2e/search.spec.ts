import { expect, test } from '@playwright/test';

import { CATEGORY_SLUGS, FIXTURES, desktopSearch, focusSearch, openSearch } from './helpers';

/**
 * Search and live suggestions.
 *
 * The two things this spec is really protecting:
 *
 * 1. **The index is not in the initial payload.** It is fetched on the first sign of search intent —
 *    a focus or a keystroke — and never on page load. That is a performance contract, and the only
 *    way to check it is to watch the network while doing nothing.
 * 2. **A search that matches nothing is still useful.** With an empty catalogue *every* query
 *    matches nothing, which makes this the state to get right: the box says so in the visitor's own
 *    words and offers the nine categories as the next step, rather than showing a blank panel.
 *
 * The SKU / material / colour / tag matching itself is exhaustively covered by the unit and
 * property suites against real fixtures (`tests/unit/search.query.test.ts`,
 * `tests/property/search.property.test.ts`); repeating it here against an empty index would assert
 * nothing.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.9, 4.13, 22.6.
 * Design: Search and Filtering.
 */

test('the search index is not fetched until there is search intent', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/search-index\//.test(pathname)) requested.push(pathname);
  });

  await page.goto('/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  expect(requested, 'the search index was in the initial payload').toStrictEqual([]);

  await focusSearch(page);
  expect(requested.length, 'focusing the box did not fetch the index').toBeGreaterThan(0);
});

test('the page advertises the index it would fetch, immutably cached', async ({
  page,
  request,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const url = await page.locator('meta[name="ngf:search-index"]').getAttribute('content');
  expect(url, 'no index URL is advertised').toBeTruthy();
  expect(String(url)).toMatch(/^\/search-index\/[^/]+\.json$/);

  const response = await request.get(String(url));
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('immutable');
  // Fingerprinted, so it can be cached forever and still change when the catalogue does.
  expect(response.headers()['content-type']).toContain('application/json');
});

test('the index is fetched once, however much is typed', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (/^\/search-index\//.test(pathname)) requested.push(pathname);
  });

  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const input = desktopSearch(page).getByRole('combobox');
  await input.pressSequentially('walnut sofa', { delay: 30 });
  await page.waitForTimeout(600);
  expect(requested.length, `the index was fetched ${String(requested.length)} times`).toBe(1);
});

test('a product query suggests the product, and the suggestion navigates to it', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const search = desktopSearch(page);
  const input = search.getByRole('combobox');
  await input.fill('L-Shape');

  const products = search.locator('[role="option"][data-kind="product"]');
  await expect(products.first()).toBeVisible({ timeout: 10_000 });
  await expect(products.first()).toContainText(FIXTURES.sofa.name);

  // The live region says how many, in words, for anyone not watching the list.
  await expect(search.locator('[role="status"]')).toContainText(/suggestion/);

  // Driven from the keyboard, exactly as the combobox contract promises.
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /-option-0$/);
  await input.press('Enter');
  await page.waitForURL(`**/product/${FIXTURES.sofa.slug}`);
  await expect(page.locator('[data-product]')).toHaveAttribute('data-product', FIXTURES.sofa.slug);
});

test('a product is findable by SKU, by material and by colour', async ({ page }) => {
  // Requirement 4.2: the box is not a name search. Each of these is a different field on the same
  // product, and each must reach it.
  for (const query of [FIXTURES.sofa.sku, FIXTURES.sofa.material, FIXTURES.sofa.colour]) {
    await page.goto('/', { waitUntil: 'load' });
    await focusSearch(page);
    const search = desktopSearch(page);
    await search.getByRole('combobox').fill(query);
    const products = search.locator('[role="option"][data-kind="product"]');
    await expect(products.first(), `"${query}" found no product`).toBeVisible({ timeout: 10_000 });
    await expect(products.first()).toContainText(FIXTURES.sofa.name);
  }
});

test('a draft product is not in the search index', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const search = desktopSearch(page);
  await search.getByRole('combobox').fill('accent chair');
  // Give the debounce and the query a moment to settle before asserting an absence.
  await page.waitForTimeout(600);
  await expect(
    search.locator(`[role="option"] a[href*="${FIXTURES.draftChair.slug}"]`),
  ).toHaveCount(0);
});

test('a query that matches nothing says so and offers the categories instead', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const search = desktopSearch(page);
  const input = search.getByRole('combobox');
  await input.fill('zzqx nonexistent piece');

  const note = search.locator('.ngf-search-note');
  await expect(note).toBeVisible({ timeout: 10_000 });
  await expect(note).toContainText('Nothing matched');
  await expect(note).toContainText('zzqx nonexistent piece');

  const shortcuts = search.locator('.ngf-search-shortcuts a');
  await expect(shortcuts).toHaveCount(CATEGORY_SLUGS.length);
  for (const slug of CATEGORY_SLUGS) {
    await expect(search.locator(`.ngf-search-shortcuts a[href="/collection/${slug}"]`)).toHaveCount(
      1,
    );
  }
});

test('a category shortcut from the search panel navigates to that category', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const search = desktopSearch(page);
  await search.getByRole('combobox').fill('zzqx unmatched');
  await expect(search.locator('.ngf-search-shortcuts a').first()).toBeVisible({ timeout: 10_000 });
  await search.locator(`.ngf-search-shortcuts a[href="/collection/${CATEGORY_SLUGS[0]}"]`).click();
  await page.waitForURL(`**/collection/${CATEGORY_SLUGS[0]}`);
  await expect(page.locator('h1')).toHaveCount(1);
});

test('Enter with no active suggestion runs the query on the catalogue page', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  await focusSearch(page);
  const input = desktopSearch(page).getByRole('combobox');
  await input.fill('zzqx no such piece');
  await input.press('Enter');
  await page.waitForURL(/\/collection\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe('zzqx no such piece');
  // And the catalogue page reports the outcome rather than showing a bare grid.
  await expect(page.locator('#ngf-collection-nomatch')).toBeVisible();
});

test('a committed search is offered back as a recent search', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  // `openSearch`, not `focusSearch`: the index is immutably cached, so the second visit in this same
  // context may not make a network request at all, and this test is about the recent-search list
  // rather than about the fetch.
  await openSearch(page);
  const input = desktopSearch(page).getByRole('combobox');
  await input.fill('rosewood bed');
  await input.press('Enter');
  await page.waitForURL(/\/collection\?/);

  await page.goto('/', { waitUntil: 'load' });
  await openSearch(page);
  const search = desktopSearch(page);
  await expect(search.locator('.ngf-search-recent')).toBeVisible({ timeout: 10_000 });
  await expect(search.locator('.ngf-search-recent a').first()).toContainText('rosewood bed');
});

test('the compact and full search boxes are both present and independently operable', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('.ngf-search-full')).toHaveCount(1);
  await expect(page.locator('.ngf-search-compact')).toHaveCount(1);

  // Two comboboxes, two distinct ids — a duplicated id would break both labels and axe would say so.
  const ids = await page
    .locator('input[role="combobox"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).id));
  expect(new Set(ids).size).toBe(ids.length);
});
