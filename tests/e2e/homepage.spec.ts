import { expect, test } from '@playwright/test';

import { CATEGORY_SLUGS, EDITORIAL_PAGES, POLICY_PAGES } from './helpers';

/**
 * The homepage and the site shell.
 *
 * The shell is on every page, so a defect here is a defect everywhere: these assertions are made
 * once, on the homepage, and the other specs assume them.
 *
 * Requirements: 2.1, 5.1, 5.2, 5.14, 6.7, 26.11.
 * Design: Pages, Navigation, and States.
 */

test('the homepage renders its shell, its hero and one h1', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('header.ngf-header')).toBeVisible();
  await expect(page.locator('main#main')).toBeVisible();
  await expect(page.locator('footer.ngf-footer')).toBeVisible();
  await expect(page.locator('a.ngf-skip')).toHaveAttribute('href', '#main');
});

test('the header offers every category and no more top-level destinations than the design allows', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  const nav = page.locator('nav.ngf-header-nav');
  await expect(nav).toHaveAttribute('aria-label', 'Main');

  // Nine categories are reachable from the header, some of them inside a group.
  for (const slug of CATEGORY_SLUGS) {
    await expect(
      nav.locator(`a[href="/collection/${slug}"]`).first(),
      `header has no route to ${slug}`,
    ).toHaveCount(1);
  }

  const topLevel = await nav.locator(':scope > ul > li').count();
  expect(topLevel, 'too many top-level destinations to scan').toBeLessThanOrEqual(9);
});

test('a header group opens, closes on Escape and returns focus to its summary', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'load' });
  const summary = page.locator('nav.ngf-header-nav details > summary').first();
  await summary.click();
  const details = page.locator('nav.ngf-header-nav details[open]');
  await expect(details).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('nav.ngf-header-nav details[open]')).toHaveCount(0);
  await expect(summary).toBeFocused();
});

test('the footer links every category, every company page and every policy', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  const footer = page.locator('footer.ngf-footer');

  for (const slug of CATEGORY_SLUGS) {
    await expect(footer.locator(`a[href="/collection/${slug}"]`)).toHaveCount(1);
  }
  for (const path of EDITORIAL_PAGES) {
    await expect(footer.locator(`a[href="${path}"]`).first(), `footer omits ${path}`).toHaveCount(
      1,
    );
  }
  for (const path of POLICY_PAGES) {
    await expect(footer.locator(`a[href="${path}"]`), `footer omits ${path}`).toHaveCount(1);
  }
});

test('the motion toggle persists a visitor’s choice to reduce motion', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  const toggle = page.locator('[data-ngf-motion-toggle]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');

  // The choice survives a navigation, which is the only thing that makes it a preference.
  await page.goto('/about', { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect(page.locator('[data-ngf-motion-toggle]')).toHaveAttribute('aria-pressed', 'true');
});

test('the homepage rails render their empty states rather than an empty grid', async ({ page }) => {
  await page.goto('/', { waitUntil: 'load' });
  // No product is published, so every product surface must say so in words a customer can act on,
  // and must offer a way to reach the business anyway.
  const empties = page.locator('[data-ngf-empty-state]');
  expect(await empties.count()).toBeGreaterThan(0);
  await expect(empties.first().locator('.ngf-emptystate-heading')).not.toHaveText('');
  await expect(empties.first().locator('a[data-ngf-whatsapp]').first()).toHaveAttribute(
    'href',
    /^https:\/\/wa\.me\//,
  );
});

test('no page states a business fact the operator has not supplied', async ({ page }) => {
  // Requirement: unknown facts render a marked placeholder rather than an invented number.
  const invented =
    /\b(?:\d+\+?\s*(?:years|yrs)\s+(?:in\s+business|of\s+experience)|\d{3,}\s+(?:happy\s+)?customers|ISO\s*\d+|award[- ]winning)\b/i;
  for (const path of ['/', '/about', '/workshop', '/faq']) {
    await page.goto(path, { waitUntil: 'load' });
    const text = (await page.locator('main#main').innerText()).replace(/\s+/g, ' ');
    expect(invented.test(text), `${path} states an unsupplied business fact`).toBe(false);
  }
});
