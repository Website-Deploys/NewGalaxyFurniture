import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and responsive sweep configuration.
 *
 * The nine widths are the design's responsive checklist, declared as named
 * projects so a failure names the width that broke. Each project asserts against
 * the built site served by `wrangler dev` — not the dev server — because the
 * Worker routing, the static asset store, and the prerendered HTML are part of
 * what is under test.
 *
 * Design: Testing Strategy → End-to-end testing, Cross-cutting checklists.
 * Requirements: 27.12.
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

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },

  projects: VIEWPORT_WIDTHS.map((width) => ({
    name: `w${width}`,
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width, height: heightFor(width) },
      isMobile: false,
      hasTouch: width <= 768,
    },
  })),

  /**
   * Build, then serve the real Worker bundle. `astro preview` is not usable with
   * the Cloudflare adapter (it registers no preview entrypoint), so the preview
   * script runs `wrangler dev` against `dist/` instead.
   */
  webServer: {
    command: 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
