import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';

/**
 * Shared facts and small helpers for the end-to-end suite.
 *
 * Every string here is a contract the application already states somewhere in `src/`. It is
 * repeated rather than imported because a Playwright spec runs in Node against a *served* site:
 * importing `@/lib/...` would pull the Worker's runtime dependencies (`astro:content`, the
 * Cloudflare bindings, the virtual env module) into the test process, and a spec that fails at
 * import time tells you nothing about the site. The unit suite already asserts these values
 * against their source of truth; here they are the *expected* side of an assertion.
 *
 * Design: Testing Strategy → End-to-end testing.
 */

/** The nine public pages that are not the catalogue, in nav order. */
export const EDITORIAL_PAGES = [
  '/about',
  '/workshop',
  '/gallery',
  '/reviews',
  '/custom-furniture',
  '/contact',
  '/faq',
] as const;

/** The five policy pages. */
export const POLICY_PAGES = ['/privacy', '/terms', '/shipping', '/returns', '/warranty'] as const;

/** The nine category slugs, which come from `data/categories/` and are not product-dependent. */
export const CATEGORY_SLUGS = [
  'sofas',
  'beds',
  'dining-tables',
  'dining-chairs',
  'accent-chairs',
  'coffee-side-tables',
  'storage-display',
  'office',
  'outdoor',
] as const;

/** Every public HTML page the site builds today, in sitemap order. */
export const PUBLIC_PAGES = [
  '/',
  '/collection',
  ...CATEGORY_SLUGS.map((slug) => `/collection/${slug}`),
  ...EDITORIAL_PAGES,
  ...POLICY_PAGES,
] as const;

/** Security headers every response must carry, and their exact values. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** The admin API surface, as method + path, for the unauthenticated probes. */
export const ADMIN_API_PROBES: readonly {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: 'none';
}[] = [
  { method: 'GET', path: '/api/admin/session' },
  { method: 'GET', path: '/api/admin/products' },
  { method: 'GET', path: '/api/admin/categories' },
  { method: 'GET', path: '/api/admin/reviews' },
  { method: 'GET', path: '/api/admin/settings' },
  { method: 'GET', path: '/api/admin/homepage' },
  { method: 'GET', path: '/api/admin/leads' },
  { method: 'GET', path: '/api/admin/analytics' },
  { method: 'GET', path: '/api/admin/deploy-status' },
  { method: 'POST', path: '/api/admin/logout' },
  { method: 'POST', path: '/api/admin/products' },
  { method: 'PATCH', path: '/api/admin/products/p_probe000001' },
  // `DELETE` carries no body: the guard refuses before it would read one, and `wrangler dev`'s
  // local proxy is unstable when a DELETE arrives with a payload.
  { method: 'DELETE', path: '/api/admin/products/p_probe000001', body: 'none' },
  { method: 'POST', path: '/api/admin/products/p_probe000001/transition' },
  { method: 'POST', path: '/api/admin/products/p_probe000001/duplicate' },
  { method: 'PATCH', path: '/api/admin/products/p_probe000001/images/order' },
  { method: 'POST', path: '/api/admin/categories' },
  { method: 'PATCH', path: '/api/admin/settings' },
  { method: 'PATCH', path: '/api/admin/homepage' },
  { method: 'POST', path: '/api/admin/ai/generate' },
  { method: 'POST', path: '/api/admin/rehydrate' },
];

/** The admin pages a signed-out visitor must be redirected away from. */
export const ADMIN_PAGES = [
  '/admin',
  '/admin/products',
  '/admin/products/new',
  '/admin/ai-assistant',
  '/admin/categories',
  '/admin/reviews',
  '/admin/leads',
  '/admin/homepage',
  '/admin/content',
  '/admin/analytics',
  '/admin/settings',
] as const;

/**
 * The fixture catalogue the build was given, mirrored from `tests/fixtures/products.ts`.
 *
 * `npm run e2e:prepare` writes those fixtures into a git-ignored directory and the build reads the
 * products collection from it, so these are the products the served site actually has. Repeated here
 * rather than imported because importing the fixture module would pull `@/schemas/product` — and
 * Zod — into the Playwright process for three strings.
 */
export const FIXTURES = {
  /** In stock, discounted, two photographs, category `sofas`. */
  sofa: {
    slug: 'demo-l-shape-sofa',
    name: '[DEMO] Brown L-Shape Sofa',
    sku: 'NGF-SOF-D00001',
    category: 'sofas',
    material: 'Sheesham Wood',
    colour: 'Brown',
    images: 2,
  },
  /** Price on enquiry and made to order: the other side of every pricing branch. Category `dining-tables`. */
  diningTable: { slug: 'demo-8-seater-dining-table', category: 'dining-tables' },
  /** A DRAFT, and therefore the control: it must appear on no public surface and in no public count. */
  draftChair: { slug: 'demo-accent-chair', category: 'accent-chairs' },
} as const;

/** Categories the fixture catalogue publishes into. */
export const POPULATED_CATEGORIES = ['sofas', 'dining-tables'] as const;

/** Published fixture products, so a count assertion has one place to change. */
export const PUBLISHED_FIXTURE_COUNT = 2;

/** A category with no published product, so the designed empty state stays under test. */
export const EMPTY_CATEGORY = 'office';

export interface E2ECredentials {
  email: string;
  password: string;
  role: string;
}

/**
 * The local-only admin credentials `npm run e2e:prepare` generated, or `null`.
 *
 * `null` means the preparation step did not run — someone pointed the suite at an already-running
 * server, or at a deployed URL. The authenticated specs skip rather than fail in that case: a
 * missing local fixture is not a defect in the site.
 */
export function e2eCredentials(): E2ECredentials | null {
  try {
    const raw = readFileSync(join(process.cwd(), 'test-results', 'e2e-admin.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'email' in parsed &&
      'password' in parsed &&
      'role' in parsed
    ) {
      const { email, password, role } = parsed as Record<string, unknown>;
      if (typeof email === 'string' && typeof password === 'string' && typeof role === 'string') {
        return { email, password, role };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A distinct caller address per label, as a header pair.
 *
 * The public enquiry endpoint allows five submissions per hour per address, which is the right rule
 * and which makes any spec that posts more than five enquiries measure the rate limiter instead of
 * the thing it meant to measure. Locally `cf-connecting-ip` is whatever the client sends; on
 * Cloudflare it is set at the edge and cannot be forged, so this is a harness affordance and not a
 * hole. The limiter itself is asserted deliberately, once, in `security.spec.ts`.
 */
/**
 * A per-run salt, so a rate-limit bucket is never inherited from an earlier run.
 *
 * The limiter's window is an hour and its state lives in `.wrangler/state`, which survives between
 * runs. Without a salt the second run of the suite within an hour starts with its allowance already
 * spent, and the rate-limit assertions fail for a reason that has nothing to do with the code.
 */
const RUN_SALT = Math.floor(Math.random() * 1_000_000);

export function callerAddress(label: string): Record<string, string> {
  let total = RUN_SALT;
  for (const character of label) total = (total * 31 + character.charCodeAt(0)) % 1_000_003;
  // Two octets of address space, not one: with a single octet two labels collided into the same
  // bucket and one spec's five submissions used up another's allowance. 203.0.113.0/24 is the
  // documentation range; this walks the whole 203.0.0.0/16 around it.
  return {
    'cf-connecting-ip': `203.0.${String(total % 254)}.${String((Math.floor(total / 254) % 254) + 1)}`,
  };
}

/**
 * Sign in through the real form, and say what went wrong when it does not work.
 *
 * A bare `waitForURL` reports "timeout" and nothing else, which is the least useful thing a failing
 * login can tell you. Racing the navigation against the form's own error region turns the same
 * failure into the message the server actually sent.
 */
let signInCount = 0;

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  // Its own caller address, per sign-in. The login endpoint allows 20 attempts per 15 minutes per
  // address — correct behaviour, and something a suite that signs in five times per run will trip
  // within two runs if every attempt comes from the same address. The ladder itself, and the
  // per-address isolation that makes this safe to do, are asserted by
  // `tests/unit/auth.session.integration.test.ts`.
  signInCount += 1;
  await page.setExtraHTTPHeaders(callerAddress(`sign-in-${String(signInCount)}`));
  await page.goto('/admin/login', { waitUntil: 'load' });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#login-submit').click();

  const error = page.locator('#login-error');
  const outcome = await Promise.race([
    page
      .waitForURL((url) => url.pathname === '/admin', { timeout: 30_000 })
      .then(() => 'signed-in'),
    error.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'refused'),
  ]);
  if (outcome === 'refused') {
    throw new Error(`sign-in was refused: ${(await error.innerText()).trim()}`);
  }
}

/** The desktop search combobox. Both variants are always mounted, so scope every search locator. */
export function desktopSearch(page: Page): Locator {
  return page.locator('.ngf-search-full');
}

/**
 * Wake the search island the way a visitor does, and wait for the index it fetches on first intent.
 *
 * The field is clicked, not the input. Below 1440 px the input is `width: 0` — the header shows a
 * magnifier that expands on focus — so the input is not a clickable target and Playwright rightly
 * refuses to click it. The field is a `label`, so clicking it focuses the input, which is exactly
 * the pointer path a visitor takes.
 */
export async function openSearch(page: Page): Promise<void> {
  const search = desktopSearch(page);
  await search.locator('.ngf-search-field').click();
  await expect(search.getByRole('combobox')).toBeFocused();
}

/**
 * Open the search box and wait until its index has actually arrived.
 *
 * The index is immutably cached, so on a second visit within one browser context the browser may
 * satisfy the request without a network round trip and no `response` event is guaranteed. Waiting on
 * the island's own readiness instead — the live region stops being empty once the index resolves,
 * either to suggestions or to "No matching products." — is both more robust and closer to what a
 * visitor perceives. Use `openSearch` where the index is beside the point.
 */
export async function focusSearch(page: Page): Promise<void> {
  const indexed = page
    .waitForResponse(
      (response: Response) => /\/search-index\/[^/]+\.json$/.test(new URL(response.url()).pathname),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await openSearch(page);
  await indexed;
}

/** Every `application/ld+json` block on the current page, parsed. */
export async function jsonLdBlocks(page: Page): Promise<Record<string, unknown>[]> {
  const texts = await page.locator('script[type="application/ld+json"]').allTextContents();
  return texts.map((text) => JSON.parse(text) as Record<string, unknown>);
}

/** The `@type` of every JSON-LD block on the page, flattened. */
export async function jsonLdTypes(page: Page): Promise<string[]> {
  const blocks = await jsonLdBlocks(page);
  return blocks.map((block) => String(block['@type']));
}

/** The `<meta name>`/`<meta property>` content, or `null` when the tag is absent. */
export async function metaContent(page: Page, name: string): Promise<string | null> {
  const byName = page.locator(`meta[name="${name}"]`);
  if ((await byName.count()) > 0) return byName.first().getAttribute('content');
  const byProperty = page.locator(`meta[property="${name}"]`);
  if ((await byProperty.count()) > 0) return byProperty.first().getAttribute('content');
  return null;
}

/**
 * Wait until the catalogue controls island has hydrated, or report that it never will.
 *
 * Two things have to happen and neither is instant. The island is `client:visible`, so on a narrow
 * viewport the controls sit below the fold and hydrate only once scrolled to — hence the
 * `scrollIntoViewIfNeeded` on the placeholder the server rendered. Then it loads the search index on
 * `requestIdleCallback` before rendering any control at all.
 *
 * The readiness signal is the sort `select`, not the filter toggle: the toggle is the *mobile*
 * sheet opener and the stylesheet hides it at 768 px and above, where the filters are a permanently
 * visible sidebar instead. Waiting for the toggle to be visible therefore hangs forever on a
 * desktop viewport, which is a fact about the design rather than a defect.
 */
export async function waitForCatalogueControls(page: Page): Promise<boolean> {
  try {
    const controls = page.locator('.ngf-controls');
    await controls.waitFor({ state: 'attached', timeout: 15_000 });
    await controls.scrollIntoViewIfNeeded();
    await page.locator('#ngf-sort').waitFor({ state: 'visible', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
