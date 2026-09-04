import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end, responsive, accessibility, SEO and security configuration.
 *
 * Every project asserts against the built site served by `wrangler dev` — not the dev server —
 * because the Worker routing, the static asset store, the security headers, and the prerendered
 * HTML are all part of what is under test.
 *
 * **Two project families, because the suite asks two different questions.**
 *
 * The design's nine widths are declared as named projects so a failure names the width that broke,
 * and the specs whose *subject* is the viewport — the responsive sweep and the motion trace — run
 * in all nine. Everything else is a behavioural spec whose subject is a flow, not a width: running
 * a login attempt or a sitemap assertion nine times over would multiply the suite's runtime by nine
 * and report the same result nine times. Those run once, in the `functional` project, at 1280 px,
 * and the handful that care about a narrow viewport resize themselves (`page.setViewportSize`) so
 * the assertion and the width it depends on sit next to each other in one file.
 *
 * **`PUBLIC_SITE_URL` is overridden at runtime, not at build time.** The admin's CSRF origin check
 * compares the browser's `Origin` against the configured site URL, so against `wrangler.toml`'s
 * production `[vars]` value every admin write from `localhost` would be refused with
 * `ORIGIN_MISMATCH` before reaching a handler — the suite would be testing the origin check and
 * nothing else. `npm run e2e:preview` therefore passes `--var PUBLIC_SITE_URL:...` to
 * `wrangler dev`, which takes precedence over `[vars]` in the Worker environment.
 *
 * Canonical links are a different matter and are deliberately left alone: they are baked from
 * `import.meta.env.PUBLIC_SITE_URL` at build time, which is the *deployment's* origin and has to
 * stay that way — a canonical pointing at `localhost` is the one thing a canonical must never do.
 * `seo.spec.ts` therefore discovers the configured origin from the served `robots.txt` and asserts
 * consistency against that, which is the real invariant and is independent of how this harness runs.
 *
 * Design: Testing Strategy → End-to-end testing, Cross-cutting checklists.
 * Requirements: 24.1, 24.2, 24.3, 24.4, 27.12.
 */

const PORT = Number(process.env.PREVIEW_PORT ?? 8788);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const isCI = process.env.CI === 'true' || process.env.CI === '1';

/** The design's nine responsive breakpoints, in px. */
const VIEWPORT_WIDTHS = [320, 375, 390, 414, 768, 1024, 1280, 1440, 1920] as const;

/** Height paired with each width: phone-ish for narrow, desktop for wide. */
function heightFor(width: number): number {
  if (width <= 414) return 844;
  if (width <= 768) return 1024;
  return 900;
}

/**
 * Where `e2e:prepare` writes the fixture products, and where the build reads them from.
 *
 * Git-ignored, rebuilt on every run, and never `data/products/` — the spec's rule is that a demo
 * product exists only under `tests/fixtures/`, and this keeps it true while still letting the suite
 * assert a real product page.
 */
const PRODUCTS_DIR = '.e2e/products';

/** The specs whose subject is the viewport itself, and so run at every width. */
const WIDTH_SENSITIVE = /(responsive|motion-trace)\.spec\.ts$/;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  /*
   * Deletes the fixture catalogue and Astro's content-layer cache when the run finishes.
   *
   * Astro caches a collection by name rather than by the directory it was loaded from, so without
   * this the next ordinary `npm run build` reuses the store this run populated and quietly emits the
   * demo product pages. See the file for the full account.
   */
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  /**
   * One worker. Not a preference — a requirement of what this suite runs against.
   *
   * Every Playwright worker drives the same single `wrangler dev` process, and its local proxy is
   * the bottleneck. Under concurrent load it starts resetting connections
   * (`disconnected: ::write(...): Connection reset by peer` inside `workerd`'s own IO, with no
   * application frame anywhere in it) and eventually the proxy controller emits an empty error and
   * the whole server exits. When that happens every remaining test fails with
   * `ERR_CONNECTION_REFUSED` — a hundred failures that say nothing about the site and bury the two
   * that did. At four workers it happened on most runs, at two on some, at one on none.
   *
   * The cost is runtime, and it is the right trade: a suite whose failures are always real is worth
   * more than one that finishes two minutes sooner. `retries` deliberately stays at zero locally for
   * the same reason — a retry that passes hides an instability rather than reporting it.
   */
  workers: 1,
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },

  projects: [
    ...VIEWPORT_WIDTHS.map((width) => ({
      name: `w${width}`,
      testMatch: WIDTH_SENSITIVE,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width, height: heightFor(width) },
        isMobile: false,
        hasTouch: width <= 768,
      },
    })),
    {
      name: 'functional',
      testIgnore: WIDTH_SENSITIVE,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        isMobile: false,
        hasTouch: true,
      },
    },
  ],

  /**
   * Migrate and seed the local Worker state, build, then serve the real Worker bundle.
   *
   * `astro preview` is not usable with the Cloudflare adapter (it registers no preview
   * entrypoint), so the preview script runs `wrangler dev` against `dist/` instead. `e2e:prepare`
   * runs first and only ever touches `--local` state: without a migrated D1 the admin endpoints
   * answer `CONFIGURATION_INCOMPLETE` and the authentication assertions would be testing the
   * absence of a database rather than the presence of a guard.
   */
  webServer: {
    command: 'npm run e2e:prepare && npm run build && npm run e2e:preview',
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // The product seam. `e2e:prepare` writes `tests/fixtures/products.ts` into this git-ignored
    // directory and `src/content.config.ts` reads the collection from it, so the catalogue, a detail
    // page and the structured data can all be asserted against real products without a demo product
    // ever reaching `data/products/`. Unset anywhere else, which is every build that ships.
    env: { NGF_PRODUCTS_DIR: PRODUCTS_DIR },
  },
});
